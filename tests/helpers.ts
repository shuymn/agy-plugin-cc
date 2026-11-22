import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy");
export const RUNNER = path.join(PLUGIN_ROOT, "scripts", "agy-run.ts");
export const WRAPPER = path.join(PLUGIN_ROOT, "bin", "agy-run");
const FAKE_AGY = path.join(ROOT, "tests", "fixtures", "fake-agy.ts");

// Standard system directories; they hold no agy.
const SYSTEM_PATH = ["/usr/bin", "/bin"];

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function makeTempDir(prefix = "agy-plugin-test-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function findOnPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  const found = result.stdout.trim();
  if (result.status !== 0 || !found) {
    throw new Error(`${command} is required for the tests`);
  }
  return found;
}

// Builds an environment without Claude Code's or the real agy's state, with
// PATH limited to node, git, (unless disabled) the fake agy, and the system
// directories that Git's own shell scripts, such as `git submodule` on Linux,
// need for basename and other coreutils.
export type FakeEnv = {
  env: NodeJS.ProcessEnv;
  home: string;
  // <XDG_STATE_HOME>/agy-plugin-cc, the runner's state directory.
  stateDir: string;
  // The runner's TMPDIR.
  tmp: string;
  readLog: () => FakeCall[];
};

// One call of the fake agy, written when it exits.
export type FakeCall = {
  argv: string[];
  cwd: string;
  pid: number;
  // The bytes agy received on stdin, base64.
  stdin: string;
  stdinBytes: number;
  // stdin bytes that arrived before the fake wrote init.
  bytesBeforeInit: number;
  initWritten: boolean;
  signals: string[];
  rejected?: string;
  // agy's environment: TMPDIR and every GIT_ variable it received.
  env: Record<string, string>;
  // The file the fake wrote into $TMPDIR, with FAKE_AGY_PROBE=1.
  probe?: string;
  childPid?: number;
};

export function makeFakeEnv(options: { agy?: boolean; steps?: readonly unknown[] } = {}): FakeEnv {
  const base = makeTempDir();
  const tools = path.join(base, "tools");
  const fakeBin = path.join(base, "fake-bin");
  const home = path.join(base, "home");
  const stateHome = path.join(base, "state");
  const tmp = path.join(base, "tmp");
  const logPath = path.join(base, "agy-calls.jsonl");
  fs.mkdirSync(tools);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  fs.symlinkSync(process.execPath, path.join(tools, "node"));
  fs.symlinkSync(findOnPath("git"), path.join(tools, "git"));
  // FAKE_AGY_CLOSE_STDIN=1 closes the read end of agy's stdin pipe before it
  // starts, so the runner's prompt write fails with EPIPE.
  fs.writeFileSync(
    path.join(fakeBin, "agy"),
    `#!/bin/sh\nif [ "$FAKE_AGY_CLOSE_STDIN" = 1 ]; then exec 0<&-; fi\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`,
    { mode: 0o755 },
  );

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|AGY|ANTIGRAVITY|FAKE_AGY|GIT_|XDG_)/.test(key) && !["HOME", "PATH", "TMPDIR"].includes(key)) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: home,
    PATH: [...(options.agy === false ? [] : [fakeBin]), tools, ...SYSTEM_PATH].join(path.delimiter),
    // Every runner the tests start keeps its state here, never in the developer's.
    XDG_STATE_HOME: stateHome,
    // The runner's scratch and snapshot directories go here, where tests can see them.
    TMPDIR: tmp,
    FAKE_AGY_LOG: logPath,
    ...(options.steps === undefined ? {} : { FAKE_AGY_STEPS: JSON.stringify(options.steps) }),
    GIT_CONFIG_NOSYSTEM: "1",
    // Keeps git from finding a repository above the temporary directories.
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });

  return {
    env,
    home,
    stateDir: path.join(stateHome, "agy-plugin-cc"),
    tmp,
    readLog: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeCall)
        : [],
  };
}

export function runRunner(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function spawnRunner(args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string }) {
  return spawn(process.execPath, [RUNNER, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Writes a prompt file outside any repository and returns its absolute path.
export function writePrompt(content: string | Buffer = "go\n"): string {
  const file = path.join(makeTempDir("agy-plugin-prompt-"), "prompt.md");
  fs.writeFileSync(file, content);
  return file;
}

// The value of a `name: value` line in the runner's stdout.
export function outputLine(stdout: string, name: string): string | undefined {
  const prefix = `${name}: `;
  return stdout
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// A repository with one commit on main.
export function makeRepo(env: NodeJS.ProcessEnv): string {
  const repo = makeTempDir("agy-plugin-repo-");
  git(repo, ["init", "-q", "-b", "main"], env);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"], env);
  git(repo, ["commit", "-q", "-m", "initial"], env);
  return repo;
}

export function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for a file the fake agy writes once it is running, and returns its content.
export async function waitForFile(file: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) || fs.readFileSync(file, "utf8") === "") {
    if (Date.now() > deadline) {
      throw new Error(`${file} never appeared`);
    }
    await sleep(20);
  }
  return fs.readFileSync(file, "utf8");
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Orphaned processes are reaped by init shortly after they exit.
export async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(20);
  }
  return true;
}

export function exitCodeOf(child: { on: (event: "close", listener: (code: number | null) => void) => unknown }) {
  return new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
}
