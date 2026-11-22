import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

import { main } from "../plugins/agy/scripts/agy-run.ts";
import type { StopTiming } from "../plugins/agy/scripts/lib/process-group.ts";
import {
  exitCodeOf,
  type FakeCall,
  type FakeEnv,
  firstLine,
  git,
  makeFakeEnv,
  makeRepo,
  makeTempDir,
  outputLine,
  runRunner,
  sleep,
  spawnRunner,
  waitForFile,
  waitUntilGone,
  writePrompt,
} from "./helpers.ts";

const BASE_ARGV = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--disable-slash-commands",
  "--dangerously-skip-permissions",
];

function setup(list?: readonly unknown[]) {
  const fake = makeFakeEnv(list === undefined ? {} : { steps: list });
  const repo = makeRepo(fake.env);
  return { fake, repo };
}

function run(fake: FakeEnv, args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return runRunner(args, { env: { ...fake.env, ...extraEnv }, cwd });
}

function steps(list: readonly unknown[]): NodeJS.ProcessEnv {
  return { FAKE_AGY_STEPS: JSON.stringify(list) };
}

function onlyCall(fake: FakeEnv): FakeCall {
  const calls = fake.readLog();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.rejected, undefined, call.rejected);
  return call;
}

function lines(stdout: string): string[] {
  return stdout.replace(/\n$/, "").split("\n");
}

type LogLine = {
  run: string;
  exit: number;
  changes: number | null;
  unknown?: string;
  continued: boolean;
  snapshotMs: { baseline: number; final?: number };
};

function readRunLog(fake: FakeEnv): LogLine[] {
  const file = path.join(fake.stateDir, "runs.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogLine);
}

function runDirOf(fake: FakeEnv, stdout: string): string {
  return path.join(fake.stateDir, "runs", outputLine(stdout, "run") ?? "");
}

// The stdin line the fake received, parsed.
function stdinMessage(call: FakeCall): unknown {
  const text = Buffer.from(call.stdin, "base64").toString("utf8");
  assert.ok(text.endsWith("\n"), "the line ends with a newline");
  assert.equal(text.indexOf("\n"), text.length - 1, "exactly one line");
  return JSON.parse(text);
}

// Runs main in this process with the fake's environment.
async function runInProcess(
  fake: FakeEnv,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stopTiming?: StopTiming; initWaitMs?: number; during?: () => Promise<void> } = {},
) {
  const saved = { ...process.env };
  process.env = { ...fake.env, ...options.env };
  let stdout = "";
  let stderr = "";
  try {
    const running = main(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      ...(options.stopTiming === undefined ? {} : { stopTiming: options.stopTiming }),
      ...(options.initWaitMs === undefined ? {} : { initWaitMs: options.initWaitMs }),
    });
    await options.during?.();
    const exit = await running;
    return { exit, stdout, stderr };
  } finally {
    process.env = saved;
  }
}

// H2
test("usage errors exit 2 before anything starts: no agy, no run line, no run directory", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const blank = writePrompt(" \n\t\n");
  const bomOnly = writePrompt(Buffer.from([0xef, 0xbb, 0xbf, 0x0a]));
  const notUtf8 = writePrompt(Buffer.from([0x67, 0x6f, 0x20, 0xff, 0xfe, 0x0a]));
  const unreadable = writePrompt();
  fs.chmodSync(unreadable, 0o000);
  const file = path.join(repo, "README.md");
  const cases: string[][] = [
    [],
    ["--prompt-file", "prompt.md"],
    ["--prompt-file", path.join(repo, "missing.md")],
    ["--prompt-file", repo],
    ["--prompt-file", blank],
    ["--prompt-file", bomOnly],
    ["--prompt-file", notUtf8],
    ["--prompt-file", unreadable],
    ["--prompt-file", prompt, "--cwd", path.join(repo, "missing")],
    ["--prompt-file", prompt, "--cwd", file],
    ["--prompt-file", prompt, "--read-only"],
    ["--prompt-file", prompt, "extra"],
    ["--prompt-file", prompt, "-C", repo],
    ["--prompt-file", prompt, "--help=yes"],
    ["--prompt-file"],
  ];
  fs.writeFileSync(path.join(repo, "prompt.md"), "relative\n");
  try {
    for (const args of cases) {
      const result = run(fake, args, repo);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(firstLine(result.stderr), /^agy-run: /);
      assert.equal(result.stdout, "", JSON.stringify(args));
    }
  } finally {
    fs.chmodSync(unreadable, 0o600);
  }
  assert.match(run(fake, ["--prompt-file", notUtf8], repo).stderr, /not valid UTF-8/);
  assert.equal(fake.readLog().length, 0);
  assert.equal(fs.existsSync(path.join(fake.stateDir, "runs")), false);
});

test("--help prints usage and exits 0 without starting agy", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--help"], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: agy-run --prompt-file/);
  assert.equal(fake.readLog().length, 0);
  assert.equal(fs.existsSync(path.join(fake.stateDir, "runs")), false);
});

// H3
test("stdin is one stream-json user message whose content is the file's text, unchanged", () => {
  const texts: Record<string, string> = {
    slash: "/help me with this\nsecond line\n",
    dash: "--thread x -p= --model y\n",
    bom: "﻿starts with a BOM\n",
    mixed: "say \"hi\" and 'bye' \\ back\\slash\n\n\ttab\r\ncrlf 日本語 é   end without newline ",
    large: `${"x".repeat(2 * 1024 * 1024 - 10)}\nend`,
  };
  for (const [name, text] of Object.entries(texts)) {
    const { fake, repo } = setup();
    const bytes = Buffer.from(text, "utf8");
    const result = run(fake, ["--prompt-file", writePrompt(bytes)], repo);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const message = stdinMessage(onlyCall(fake));
    assert.deepEqual(message, { event: "user", message: { content: text } }, name);
    const content = (message as { message: { content: string } }).message.content;
    assert.ok(Buffer.from(content, "utf8").equals(bytes), name);
  }
});

// H4
test("argv: the stream-json flags, no --conversation, --model, or --effort unless given, and -p= last", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const first = run(fake, ["--prompt-file", prompt], repo);
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  const resumed = run(
    fake,
    ["--prompt-file", prompt, "--thread", thread, "--model", "gemini x", "--effort", "high"],
    repo,
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const [newCall, resumeCall] = fake.readLog();
  assert.deepEqual(newCall?.argv, [...BASE_ARGV, "-p="]);
  assert.deepEqual(resumeCall?.argv, [
    ...BASE_ARGV,
    "--conversation",
    thread,
    "--model",
    "gemini x",
    "--effort",
    "high",
    "-p=",
  ]);
  for (const call of [newCall, resumeCall]) {
    assert.equal(call?.rejected, undefined, call?.rejected);
  }
});

// H5, H6
test("a successful run prints the short report, and result.md and events.jsonl keep agy's bytes", () => {
  const { fake, repo } = setup();
  // Unlike the last progress delta, ends without a newline and holds non-ASCII text.
  const response = `# Title\n\n${"y".repeat(512 * 1024)}\n日本語 "quoted" \\ trailing  `;
  const responseFile = path.join(makeTempDir(), "response");
  fs.writeFileSync(responseFile, response);
  const stdoutCopy = path.join(makeTempDir(), "stdout");
  const actions = [
    { write: "a\nb.txt", content: "newline in the name\n" },
    ...Array.from({ length: 99 }, (_, index) => ({
      write: `files/f${String(index).padStart(3, "0")}.txt`,
      content: "x",
    })),
  ];
  const result = run(fake, ["--prompt-file", writePrompt()], repo, {
    FAKE_AGY_RESPONSE_FILE: responseFile,
    FAKE_AGY_ACTIONS: JSON.stringify(actions),
    FAKE_AGY_STDOUT_COPY: stdoutCopy,
    ...steps([
      { raw: "not json\r\n" },
      "init",
      "read",
      "actions",
      { delta: "Final answer below." },
      { raw: "[1, 2]\n" },
      { result: {} },
      { raw: "trailing line without newline" },
    ]),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const out = lines(result.stdout);
  const runId = outputLine(result.stdout, "run");
  assert.match(runId ?? "", /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.equal(out[0], `run: ${runId}`);
  assert.match(out[1] ?? "", /^scratch: \//);
  assert.match(out[2] ?? "", /^thread: [0-9a-f-]{36}$/);
  assert.equal(out[3], "status: ok (exit 0)");
  const runDir = runDirOf(fake, result.stdout);
  const resultFile = path.join(runDir, "result.md");
  assert.equal(out[4], `result: ${resultFile}`);
  assert.equal(out[5], `cwd: ${repo}`);
  assert.match(out[6] ?? "", new RegExp(`^changes: 100 files \\(baseline [0-9a-f]{40}, paths relative to ${repo}\\)$`));
  assert.equal(out[7], "  A a\\nb.txt");
  assert.equal(out.length, 7 + 11);
  assert.equal(out.at(-1), `  ... full list: ${path.join(runDir, "changes.txt")}`);

  assert.equal(fs.readFileSync(resultFile, "utf8"), response);
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"));
  assert.ok(events.equals(fs.readFileSync(stdoutCopy)), "events.jsonl equals agy's stdout");
  const resultEvent = events
    .toString("utf8")
    .split("\n")
    .find((line) => line.startsWith('{"event":"result"'));
  assert.equal((JSON.parse(resultEvent ?? "{}") as { result: { response: string } }).result.response, response);

  const listing = fs.readFileSync(path.join(runDir, "changes.txt"), "utf8").split("\n");
  assert.match(listing[0] ?? "", /^baseline [0-9a-f]{40}$/);
  assert.equal(listing[0], `baseline ${/baseline ([0-9a-f]{40})/.exec(out[6] ?? "")?.[1]}`);
  assert.match(listing[1] ?? "", /^final [0-9a-f]{40}$/);
  assert.deepEqual(listing.slice(2), [
    "A\ta\\nb.txt",
    ...Array.from({ length: 99 }, (_, index) => `A\tfiles/f${String(index).padStart(3, "0")}.txt`),
    "",
  ]);

  const [logLine] = readRunLog(fake);
  assert.equal(logLine?.run, runId);
  assert.equal(logLine?.exit, 0);
  assert.equal(logLine?.changes, 100);
  assert.equal(logLine?.continued, false);
  assert.equal(typeof logLine?.snapshotMs.final, "number");
  assert.doesNotMatch(JSON.stringify(logLine), /Title|a\\nb|files\/|sandbox/);
});

// H5
test("scratch: is printed before agy starts and thread: only after it reports init", async () => {
  const { fake, repo } = setup(["ready", { sleep: 300 }, "init", "read", { result: {} }]);
  const ready = path.join(makeTempDir(), "ready");
  const child = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_AGY_READY_FILE: ready },
    cwd: repo,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = exitCodeOf(child);
  await waitForFile(ready);
  const atStart = stdout;
  assert.equal(await exited, 0);
  assert.match(atStart, /^run: \S+\nscratch: \S+\n$/);
  assert.match(outputLine(stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
});

test("a run that fails before init prints no thread line and names agy's exit and last stderr line", () => {
  const { fake, repo } = setup([{ stderr: "starting\nError: no credentials\n" }, { exit: 1 }]);
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 1);
  assert.equal(outputLine(result.stdout, "thread"), undefined);
  assert.equal(outputLine(result.stdout, "result"), undefined);
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  assert.equal(outputLine(result.stdout, "changes"), "none");
  const stderr = result.stderr.trimEnd().split("\n");
  assert.equal(stderr[0], "agy-run: agy exited 1: Error: no credentials");
  assert.deepEqual(stderr.slice(1), ["starting", "Error: no credentials"]);
  assert.equal(onlyCall(fake).stdinBytes, 0);
  assert.equal(readRunLog(fake)[0]?.run, outputLine(result.stdout, "run"));
});

// H6
test("a turn that is not a usable answer exits 1 without result:, with the reason", () => {
  const noise = Array.from({ length: 100 }, (_, index) => `noise ${index}\n`).join("");
  const cases: [string, unknown[], RegExp | string][] = [
    ["status ERROR", ["init", "read", { result: { status: "ERROR" } }], "status: ERROR"],
    ["empty response", ["init", "read", { result: { response: "" } }], "empty response"],
    ["missing response", ["init", "read", { result: { response: null } }], "empty response"],
    [
      "print timeout",
      ["init", "read", { result: { finished_reason: "print_timeout" } }],
      "finished_reason: print_timeout",
    ],
    [
      "AGY_ERROR",
      [
        "init",
        "read",
        {
          stderr: `AGY_ERROR: {"short_error":"model quota exhausted","status":"DEADLINE_EXCEEDED","reason":"print_timeout"}\n${noise}`,
        },
        { result: {} },
      ],
      "model quota exhausted",
    ],
    [
      "AGY_ERROR without short_error",
      ["init", "read", { stderr: 'AGY_ERROR: {"reason":"print_timeout"}\n' }, { result: {} }],
      "print_timeout",
    ],
    ["AGY_ERROR not JSON", ["init", "read", { stderr: "AGY_ERROR: broken\n" }, { result: {} }], "AGY_ERROR: broken"],
    [
      "result.error",
      [{ stderr: "Error: unknown model\n" }, { result: { status: "ERROR", error: "model x not found" } }],
      "model x not found",
    ],
    ["no result", ["init", "read", { stderr: "log line\nlast words\n" }], "no result event (agy exited 0): last words"],
    ["no init", [{ result: {} }], "no init event"],
    ["result before init", [{ result: {} }, "init", "read"], "result before prompt"],
    ["two inits", ["init", { init: { id: "other-id" } }, "read", { result: {} }], "multiple init events"],
    ["two results", ["init", "read", { result: {} }, { result: {} }], "multiple result events"],
    [
      "result id differs",
      ["init", "read", { result: { conversation_id: "someone-else" } }],
      /^result conversation someone-else differs from init [0-9a-f-]{36}$/,
    ],
    [
      "jetski",
      [
        "init",
        "read",
        { stderr: 'jetski: no output produced — a tool required the "write" permission\n' },
        { result: { response: "" } },
      ],
      'jetski: no output produced — a tool required the "write" permission',
    ],
    ["agy exits non-zero", ["init", "read", { result: {} }, { exit: 3 }], "agy exited 3"],
    [
      "invalid init id",
      [{ init: { id: "../bad" } }, "read", { result: {} }],
      "invalid conversation id from agy: ../bad",
    ],
  ];
  for (const [name, list, reason] of cases) {
    const { fake, repo } = setup(list);
    const result = run(fake, ["--prompt-file", writePrompt()], repo);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.equal(outputLine(result.stdout, "result"), undefined, name);
    assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)", name);
    assert.equal(outputLine(result.stdout, "changes"), "none", name);
    const summary = firstLine(result.stderr).replace(/^agy-run: /, "");
    if (typeof reason === "string") {
      assert.equal(summary, reason, name);
    } else {
      assert.match(summary, reason, name);
    }
    const runDir = runDirOf(fake, result.stdout);
    assert.equal(fs.existsSync(path.join(runDir, "result.md")), false, name);
    if (name === "AGY_ERROR") {
      // The line is latched although the tail shown keeps only the last 40 lines.
      assert.doesNotMatch(result.stderr.split("\n").slice(1).join("\n"), /AGY_ERROR/);
    }
    if (name === "no init" || name === "invalid init id") {
      assert.equal(onlyCall(fake).stdinBytes, 0, name);
      assert.equal(outputLine(result.stdout, "thread"), undefined, name);
      assert.equal(fs.existsSync(path.join(fake.stateDir, "threads")), false, name);
    }
  }
});

test("a jetski line with a non-empty SUCCESS response is ok", () => {
  const { fake, repo } = setup([
    "init",
    "read",
    { stderr: 'jetski: no output produced — a tool required the "write" permission\n' },
    { result: {} },
  ]);
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputLine(result.stdout, "status"), "ok (exit 0)");
});

test("a prompt that agy never received fails the run, even with a SUCCESS result", () => {
  const { fake, repo } = setup(["init", { sleep: 200 }, { result: {} }]);
  const result = run(fake, ["--prompt-file", writePrompt("x".repeat(2 * 1024 * 1024))], repo, {
    FAKE_AGY_CLOSE_STDIN: "1",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(firstLine(result.stderr), /^agy-run: prompt not sent: .*EPIPE/);
  assert.equal(outputLine(result.stdout, "result"), undefined);
  assert.equal(onlyCall(fake).stdinBytes, 0);
});

test("a prompt write error stops an agy that keeps running and exits 1", () => {
  const { fake, repo } = setup(["init", "hang"]);
  const result = run(fake, ["--prompt-file", writePrompt("x".repeat(2 * 1024 * 1024))], repo, {
    FAKE_AGY_CLOSE_STDIN: "1",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(firstLine(result.stderr), /^agy-run: prompt not sent: .*EPIPE/);
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  const call = onlyCall(fake);
  assert.deepEqual(call.signals, ["SIGINT"]);
  assert.equal(call.stdinBytes, 0);
});

test("an agy on PATH that cannot be started exits 1 with the normal report", () => {
  const fake = makeFakeEnv({ agy: false });
  const repo = makeRepo(fake.env);
  const bin = makeTempDir();
  // execve fails: the interpreter does not exist.
  fs.writeFileSync(path.join(bin, "agy"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  const result = run(fake, ["--prompt-file", writePrompt()], repo, {
    PATH: `${bin}${path.delimiter}${fake.env.PATH ?? ""}`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(firstLine(result.stderr), /^agy-run: agy could not start: .*ENOENT/);
  assert.match(outputLine(result.stdout, "run") ?? "", /^\d{8}T/);
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  assert.equal(outputLine(result.stdout, "changes"), "none");
  assert.deepEqual(fs.readdirSync(fake.tmp), []);
});

test("a non-empty response with denied actions is ok", () => {
  const { fake, repo } = setup(["init", "read", { result: { denied_actions: ["write_file"] } }]);
  const result = run(fake, ["--prompt-file", writePrompt()], repo, { FAKE_AGY_RESPONSE: "The write was denied." });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(outputLine(result.stdout, "result") ?? "", "utf8"), "The write was denied.");
});

test("no init within the wait stops agy before it receives any stdin", async () => {
  const fake = makeFakeEnv({ steps: ["hang"] });
  const repo = makeRepo(fake.env);
  const ready = path.join(makeTempDir(), "ready");
  // The bound leaves the fake far more time than it needs to start and set
  // up its signal handlers, which it confirms with the ready file; the logged
  // SIGINT below shows the stop came after that.
  const result = await runInProcess(fake, ["--prompt-file", writePrompt(), "--cwd", repo], {
    env: { FAKE_AGY_READY_FILE: ready },
    initWaitMs: 5_000,
    during: async () => {
      await waitForFile(ready, 10_000);
    },
  });
  assert.equal(result.exit, 1, result.stderr);
  assert.equal(firstLine(result.stderr), "agy-run: no init event within 5s");
  assert.equal(outputLine(result.stdout, "thread"), undefined);
  const call = onlyCall(fake);
  assert.equal(call.stdinBytes, 0);
  assert.deepEqual(call.signals, ["SIGINT"]);
});

test("a directory at result.md fails the run, which still reports and removes the scratch directory", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--prompt-file", writePrompt()], repo, { FAKE_AGY_BLOCK: "result.md" });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /^agy-run: result\.md not written: /);
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  assert.equal(outputLine(result.stdout, "result"), undefined);
  assert.equal(outputLine(result.stdout, "changes"), "none");
  assert.equal(outputLine(result.stdout, "scratch left"), undefined);
  assert.deepEqual(fs.readdirSync(fake.tmp), []);
});

test("an events archive that cannot be written only warns", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--prompt-file", writePrompt()], repo, { FAKE_AGY_BLOCK: "events.jsonl" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputLine(result.stdout, "status"), "ok (exit 0)");
  const warnings = result.stderr.split("\n").filter((line) => line.startsWith("agy-run: events not saved: "));
  assert.equal(warnings.length, 1, result.stderr);
});

// H7
test("a resume whose init names another conversation is stopped before the prompt and keeps the record", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const first = run(fake, ["--prompt-file", prompt], repo);
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  const recordFile = path.join(fake.stateDir, "threads", `${thread}.json`);
  const record = fs.readFileSync(recordFile);

  const stale = run(
    fake,
    ["--prompt-file", prompt, "--thread", thread],
    repo,
    steps([
      { stderr: `warning: conversation "${thread}" not found\n` },
      { init: { id: "replacement-id" } },
      "read",
      { result: {} },
    ]),
  );
  assert.equal(stale.status, 1);
  assert.equal(firstLine(stale.stderr), `agy-run: stale conversation: requested ${thread}, agy started replacement-id`);
  assert.equal(outputLine(stale.stdout, "thread"), undefined);
  const [, call] = fake.readLog();
  assert.equal(call?.stdinBytes, 0);
  assert.ok(fs.readFileSync(recordFile).equals(record));
  assert.equal(fs.existsSync(path.join(fake.stateDir, "threads", "replacement-id.json")), false);
});

test("on a new run the prompt arrives only after agy wrote init", () => {
  const { fake, repo } = setup([{ sleep: 300 }, "init", "read", { result: {} }]);
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 0, result.stderr);
  const call = onlyCall(fake);
  assert.equal(call.bytesBeforeInit, 0);
  assert.ok(call.stdinBytes > 0);
});

test("a failure to record the conversation stops agy before the prompt and exits 1", () => {
  const { fake, repo } = setup();
  const threads = path.join(fake.stateDir, "threads");
  fs.mkdirSync(threads, { recursive: true });
  fs.chmodSync(threads, 0o500);
  try {
    const result = run(fake, ["--prompt-file", writePrompt()], repo);
    assert.equal(result.status, 1);
    assert.match(firstLine(result.stderr), /^agy-run: thread record not written: /);
    assert.match(outputLine(result.stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(onlyCall(fake).stdinBytes, 0);
    assert.deepEqual(fs.readdirSync(fake.tmp), []);
  } finally {
    fs.chmodSync(threads, 0o700);
  }
});

// H9
test("a failed run with changes still exits 1 and lists the changes", () => {
  const { fake, repo } = setup(["init", "read", "actions", { stderr: "log line\n" }, { result: { status: "ERROR" } }]);
  const result = run(fake, ["--prompt-file", writePrompt()], repo, {
    FAKE_AGY_ACTIONS: JSON.stringify([{ write: "README.md", content: "changed\n" }]),
  });
  assert.equal(result.status, 1);
  assert.match(outputLine(result.stdout, "changes") ?? "", /^1 files \(baseline /);
  assert.match(result.stdout, /\n {2}M README\.md\n/);
  assert.deepEqual(result.stderr.trimEnd().split("\n"), ["agy-run: status: ERROR", "log line"]);
});

// H9, H12
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} stops agy and its child, reports the changes as interrupted, and exits ${code}`, async () => {
    const { fake, repo } = setup(["child", "init", "hang"]);
    const ready = path.join(makeTempDir(), "ready");
    const childFile = path.join(makeTempDir(), "child");
    const runner = spawnRunner(["--prompt-file", writePrompt()], {
      env: { ...fake.env, FAKE_AGY_READY_FILE: ready, FAKE_AGY_CHILD_FILE: childFile },
      cwd: repo,
    });
    let stdout = "";
    runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    const exited = exitCodeOf(runner);
    const agyPid = Number(await waitForFile(ready));
    const childPid = Number(await waitForFile(childFile));
    const deadline = Date.now() + 10_000;
    while (outputLine(stdout, "thread") === undefined && Date.now() < deadline) {
      await sleep(20);
    }
    runner.kill(signal);
    assert.equal(await exited, code);
    assert.ok(await waitUntilGone(agyPid), "agy is still running");
    assert.ok(await waitUntilGone(childPid), "agy's child is still running");
    assert.deepEqual(onlyCall(fake).signals, ["SIGINT"]);
    assert.equal(outputLine(stdout, "status"), `interrupted (exit ${code})`);
    assert.match(outputLine(stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(outputLine(stdout, "result"), undefined);
    assert.match(outputLine(stdout, "changes") ?? "", /^unknown: interrupted \(baseline [0-9a-f]{40}\)$/);
    assert.equal(outputLine(stdout, "scratch left"), undefined);
    assert.deepEqual(fs.readdirSync(fake.tmp), []);
    assert.equal(readRunLog(fake)[0]?.unknown, "interrupted");
  });
}

// H12
test("an init that arrives after the runner received SIGINT is reported but gets no prompt", async () => {
  const { fake, repo } = setup([{ hang: { initOnSignal: true } }]);
  const ready = path.join(makeTempDir(), "ready");
  const runner = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_AGY_READY_FILE: ready },
    cwd: repo,
  });
  let stdout = "";
  runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = exitCodeOf(runner);
  await waitForFile(ready);
  runner.kill("SIGINT");
  assert.equal(await exited, 130);
  const call = onlyCall(fake);
  assert.equal(call.initWritten, true);
  assert.equal(call.stdinBytes, 0);
  // The conversation is still reported and recorded, so it can be continued.
  const thread = outputLine(stdout, "thread");
  assert.match(thread ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(fs.existsSync(path.join(fake.stateDir, "threads", `${thread}.json`)));
  assert.equal(outputLine(stdout, "status"), "interrupted (exit 130)");
});

test("a record write failure for an init accepted while stopping is reported on stderr", async () => {
  const { fake, repo } = setup([{ hang: { initOnSignal: true } }]);
  // A regular file where the threads directory should be.
  fs.mkdirSync(fake.stateDir, { recursive: true });
  fs.writeFileSync(path.join(fake.stateDir, "threads"), "not a directory");
  const ready = path.join(makeTempDir(), "ready");
  const runner = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_AGY_READY_FILE: ready },
    cwd: repo,
  });
  let stdout = "";
  let stderr = "";
  runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  runner.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = exitCodeOf(runner);
  await waitForFile(ready);
  runner.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.match(outputLine(stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(outputLine(stdout, "status"), "interrupted (exit 130)");
  assert.match(firstLine(stderr), /^agy-run: thread record not written: /);
  assert.equal(onlyCall(fake).stdinBytes, 0);
});

// H9, H12
test("a process group that cannot be confirmed gone exits 1 even after a signal, and leaves the scratch directory", async () => {
  const fake = makeFakeEnv({ steps: ["init", "hang"] });
  const repo = makeRepo(fake.env);
  const ready = path.join(makeTempDir(), "ready");
  let agyPid = 0;
  let result;
  try {
    result = await runInProcess(fake, ["--prompt-file", writePrompt(), "--cwd", repo], {
      env: { FAKE_AGY_READY_FILE: ready },
      stopTiming: {
        interruptGraceMs: 50,
        terminateGraceMs: 50,
        reapGraceMs: 200,
        // The group looks alive and cannot be signaled, as with EPERM.
        kill: (pid, signal) => {
          void pid;
          if (signal !== 0) {
            throw Object.assign(new Error("kill failed: EPERM"), { code: "EPERM" });
          }
        },
      },
      during: async () => {
        agyPid = Number(await waitForFile(ready));
        process.kill(process.pid, "SIGTERM");
      },
    });
  } finally {
    if (agyPid) {
      process.kill(agyPid, "SIGKILL");
    }
  }
  assert.ok(await waitUntilGone(agyPid));
  assert.equal(result.exit, 1);
  assert.match(
    firstLine(result.stderr),
    /^agy-run: process group not confirmed gone: could not signal process group \d+ \(EPERM\)$/,
  );
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  assert.match(outputLine(result.stdout, "changes") ?? "", /^unknown: reap-error \(baseline [0-9a-f]{40}\)$/);
  const scratch = outputLine(result.stdout, "scratch");
  assert.ok(scratch);
  assert.equal(outputLine(result.stdout, "scratch left"), scratch);
  assert.ok(fs.existsSync(scratch));
  assert.equal(readRunLog(fake)[0]?.unknown, "reap-error");
});

// H10
test("a missing agy exits 3 before the run starts", () => {
  const fake = makeFakeEnv({ agy: false });
  const repo = makeRepo(fake.env);
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(firstLine(result.stderr), "agy-run: agy was not found on PATH.");
  assert.equal(fs.existsSync(path.join(fake.stateDir, "runs")), false);
});

test("an agy that exits before reading a large prompt does not crash the runner", () => {
  const { fake, repo } = setup(["init", { exit: 1 }]);
  const result = run(fake, ["--prompt-file", writePrompt(`go ${"x".repeat(4 * 1024 * 1024)}`)], repo);
  assert.equal(result.status, 1);
  // The write fails once agy has gone, so the prompt counts as not sent.
  assert.match(firstLine(result.stderr), /^agy-run: prompt not sent: /);
});

test("the runner exits as soon as a quick agy has finished", async () => {
  const { fake, repo } = setup();
  const started = Date.now();
  const runner = spawnRunner(["--prompt-file", writePrompt()], { env: fake.env, cwd: repo });
  assert.equal(await exitCodeOf(runner), 0);
  // Nothing may hold the runner open, such as the init wait or the stream timer.
  assert.ok(Date.now() - started < 10_000);
  const log = fake.readLog();
  assert.equal(log.length, 1);
});

// A git on PATH that records the GIT_ variables of every call the runner
// makes, then runs the real git.
function loggingGit(fake: FakeEnv): { dir: string; calls: () => Record<string, string>[] } {
  const dir = makeTempDir();
  const log = path.join(dir, "calls.log");
  const realGit = fs.realpathSync(path.join(path.dirname(fake.tmp), "tools", "git"));
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh\n{ echo ---; env | grep '^GIT_'; } >> "${log}"\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const calls = () =>
    fs
      .readFileSync(log, "utf8")
      .split("---\n")
      .filter(Boolean)
      .map((block) =>
        Object.fromEntries(
          block
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        ),
      );
  return { dir, calls };
}

// H11
test("agy gets the scratch directory as TMPDIR, without the caller's repository-selection variables, and the scratch directory is deleted", () => {
  const { fake, repo } = setup();
  const worktree = path.join(makeTempDir(), "wt");
  git(repo, ["worktree", "add", "-q", "-b", "wt", worktree], fake.env);
  const other = makeRepo(fake.env);
  const otherGit = path.join(other, ".git");
  const logged = loggingGit(fake);
  const ceiling = fake.env.GIT_CEILING_DIRECTORIES;
  assert.ok(ceiling);
  // Every variable that selects a repository, all pointing at another one.
  const selection: Record<string, string> = {
    GIT_DIR: otherGit,
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(otherGit, "index"),
    GIT_COMMON_DIR: otherGit,
    GIT_OBJECT_DIRECTORY: path.join(otherGit, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(otherGit, "objects"),
  };
  const result = run(fake, ["--prompt-file", writePrompt(), "--cwd", worktree], other, {
    PATH: `${logged.dir}${path.delimiter}${fake.env.PATH ?? ""}`,
    ...selection,
    FAKE_AGY_PROBE: "1",
    FAKE_AGY_ACTIONS: JSON.stringify([{ write: "made-in-worktree.txt", content: "x" }]),
  });
  assert.equal(result.status, 0, result.stderr);
  const call = onlyCall(fake);
  const scratch = outputLine(result.stdout, "scratch");
  assert.ok(scratch);
  assert.equal(call.env.TMPDIR, scratch);
  for (const name of Object.keys(selection)) {
    assert.equal(call.env[name], undefined, name);
  }
  assert.equal(call.env.GIT_CEILING_DIRECTORIES, ceiling);

  // The runner's own Git calls: none of the six, except the snapshot's own
  // temporary index, and the ceiling kept.
  const gitCalls = logged.calls();
  assert.ok(gitCalls.length > 0);
  for (const env of gitCalls) {
    for (const name of Object.keys(selection)) {
      if (name === "GIT_INDEX_FILE" && env[name] !== undefined) {
        assert.ok(env[name].startsWith(`${fake.tmp}${path.sep}`), env[name]);
      } else {
        assert.equal(env[name], undefined, `${name} in ${JSON.stringify(env)}`);
      }
    }
    assert.equal(env.GIT_CEILING_DIRECTORIES, ceiling);
  }

  assert.ok(call.probe?.startsWith(`${scratch}${path.sep}`));
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(outputLine(result.stdout, "scratch left"), undefined);
  assert.equal(call.cwd, worktree);
  // The workspace root and the snapshot come from --cwd, not from GIT_WORK_TREE.
  assert.match(
    outputLine(result.stdout, "changes") ?? "",
    new RegExp(`^1 files \\(baseline [0-9a-f]{40}, paths relative to ${fs.realpathSync(worktree)}\\)$`),
  );
  assert.match(result.stdout, /\n {2}A made-in-worktree\.txt\n/);
});

test("a scratch directory that cannot be deleted is printed as scratch left", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--prompt-file", writePrompt()], repo, { FAKE_AGY_LOCK_SCRATCH: "1" });
  const scratch = outputLine(result.stdout, "scratch");
  assert.ok(scratch);
  const locked = path.join(scratch, "locked");
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(outputLine(result.stdout, "scratch left"), scratch);
    assert.ok(fs.existsSync(locked));
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("an exception from the baseline snapshot is reported as unknown, and agy still runs", async () => {
  const { fake, repo } = setup();
  const original = fs.mkdtempSync;
  // Only the snapshot's temporary index fails, as on a full disk.
  const mocked = mock.method(fs, "mkdtempSync", (prefix: string, options?: fs.EncodingOption) => {
    if (prefix.includes("agy-plugin-snapshot-")) {
      throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" });
    }
    return original(prefix, options);
  });
  try {
    const result = await runInProcess(fake, ["--prompt-file", writePrompt(), "--cwd", repo]);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(fake.readLog().length, 1);
    assert.equal(outputLine(result.stdout, "status"), "ok (exit 0)");
    assert.equal(
      outputLine(result.stdout, "changes"),
      "unknown: baseline snapshot failed: ENOSPC: no space left on device, mkdtemp",
    );
    assert.equal(readRunLog(fake)[0]?.unknown, "snapshot-failed");
  } finally {
    mocked.mock.restore();
  }
});

test("a stopped run outside Git reports the interruption, not the missing baseline", async () => {
  const fake = makeFakeEnv({ steps: ["init", "hang"] });
  const plain = makeTempDir();
  const ready = path.join(makeTempDir(), "ready");
  const runner = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_AGY_READY_FILE: ready },
    cwd: plain,
  });
  let stdout = "";
  runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = exitCodeOf(runner);
  await waitForFile(ready);
  runner.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.equal(outputLine(stdout, "changes"), "unknown: interrupted");
  assert.equal(readRunLog(fake)[0]?.unknown, "interrupted");
});

test("a whitespace-only response is non-empty, so the run succeeds and keeps it unchanged", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--prompt-file", writePrompt()], repo, { FAKE_AGY_RESPONSE: " \n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(outputLine(result.stdout, "result") ?? "", "utf8"), " \n");
});
