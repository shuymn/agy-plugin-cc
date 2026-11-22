// Stand-in for the Antigravity CLI in tests. It checks the argv the way the
// real flag parser would, collects stdin from the start (so it can tell what
// arrived before it wrote init), plays the steps in FAKE_AGY_STEPS, and on
// exit appends one JSON line describing the call to FAKE_AGY_LOG.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_AGY_LOG;

// One step of the script. A string names a step without parameters.
type Step =
  | "init"
  | "read"
  | "actions"
  | "ready"
  | "hang"
  | "escape"
  | "child"
  | { init: { id?: unknown } }
  | { result: Record<string, unknown> }
  | { delta: string }
  | { raw: string }
  | { stderr: string }
  | { sleep: number }
  | { exit: number }
  | { hang: { ignoreSigint?: boolean; initOnSignal?: boolean } };

const DEFAULT_STEPS: Step[] = ["init", "read", "actions", { delta: "Working on it." }, { result: {} }];

const stdinChunks: Buffer[] = [];
let stdinEnded = false;
let initWritten = false;
let bytesBeforeInit = 0;
const signals: string[] = [];
let rejected: string | undefined;
let probe: string | undefined;

process.stdin.on("data", (chunk: Buffer) => {
  stdinChunks.push(chunk);
  if (!initWritten) {
    bytesBeforeInit += chunk.length;
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
});
process.stdin.on("error", () => {});

// What a probe would report: TMPDIR and the Git variables agy received.
function agyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if ((key === "TMPDIR" || key.startsWith("GIT_")) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

process.on("exit", () => {
  if (!logPath) {
    return;
  }
  const stdin = Buffer.concat(stdinChunks);
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      env: agyEnv(),
      stdin: stdin.toString("base64"),
      stdinBytes: stdin.length,
      bytesBeforeInit,
      initWritten,
      signals,
      ...(rejected === undefined ? {} : { rejected }),
      ...(probe === undefined ? {} : { probe }),
    })}\n`,
  );
});

function reject(reason: string): never {
  rejected = reason;
  process.stderr.write(`flags provided but not defined: ${reason}\n`);
  process.exit(2);
}

// Go's flag package: -name, --name, -name=value; value flags take the next
// argument when no "=" is given; parsing stops at the first non-flag.
const VALUE_FLAGS = new Set(["input-format", "output-format", "conversation", "model", "effort", "settings", "p"]);
const BOOL_FLAGS = new Set(["disable-slash-commands", "dangerously-skip-permissions"]);

function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      reject(`unexpected argument ${arg}`);
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (BOOL_FLAGS.has(name)) {
      flags.set(name, eq === -1 ? "true" : body.slice(eq + 1));
    } else if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        flags.set(name, body.slice(eq + 1));
      } else {
        const value = args[index + 1];
        if (value === undefined) {
          reject(`flag needs an argument: -${name}`);
        }
        flags.set(name, value);
        index += 1;
      }
    } else {
      reject(`-${name}`);
    }
  }
  return flags;
}

const flags = parseFlags(argv);
if (!flags.has("p")) {
  reject("missing -p");
}
if (flags.get("input-format") === "stream-json" && flags.get("output-format") !== "stream-json") {
  reject("--input-format stream-json requires --output-format stream-json");
}

let conversationId = flags.get("conversation") ?? randomUUID();

// Everything written to stdout, also appended to FAKE_AGY_STDOUT_COPY.
function out(text: string): void {
  if (process.env.FAKE_AGY_STDOUT_COPY) {
    fs.appendFileSync(process.env.FAKE_AGY_STDOUT_COPY, text);
  }
  process.stdout.write(text);
}

function emit(event: Record<string, unknown>): void {
  out(`${JSON.stringify(event)}\n`);
}

function writeInit(id: unknown = conversationId): void {
  if (typeof id === "string") {
    conversationId = id;
  }
  emit({
    event: "init",
    conversation_id: id,
    init: { cwd: process.cwd(), tools: [], permission_mode: "request-review" },
  });
  initWritten = true;
}

function response(): string {
  if (process.env.FAKE_AGY_RESPONSE_FILE !== undefined) {
    return fs.readFileSync(process.env.FAKE_AGY_RESPONSE_FILE, "utf8");
  }
  return process.env.FAKE_AGY_RESPONSE ?? "Fake final response.";
}

function writeResult(overrides: Record<string, unknown>): void {
  const result: Record<string, unknown> = {
    conversation_id: conversationId,
    status: "SUCCESS",
    response: response(),
    duration_seconds: 0.1,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  emit({ event: "result", result });
}

// Edits to the working tree, relative to the cwd, applied in order:
// FAKE_AGY_ACTIONS='[{"write":"a.txt","content":"x"},{"delete":"b.txt"}]'.
type Action = { write?: string; content?: string; delete?: string };

function applyActions(): void {
  const actions = JSON.parse(process.env.FAKE_AGY_ACTIONS ?? "[]") as Action[];
  for (const action of actions) {
    if (action.write !== undefined) {
      fs.mkdirSync(path.dirname(path.resolve(action.write)), { recursive: true });
      fs.writeFileSync(action.write, action.content ?? "");
    } else if (action.delete !== undefined) {
      fs.rmSync(action.delete);
    }
  }
}

// Leaves a file in $TMPDIR without cleaning up, like a probe script.
function writeProbe(): void {
  if (process.env.FAKE_AGY_PROBE !== "1" || !process.env.TMPDIR) {
    return;
  }
  const dir = path.join(process.env.TMPDIR, "probe");
  fs.mkdirSync(dir, { recursive: true });
  probe = path.join(dir, "probe.sh");
  fs.writeFileSync(probe, "echo probe\n");
}

// Leaves a directory in $TMPDIR that the runner cannot delete: a file in a
// directory without write permission. The test restores the permission.
function lockScratch(): void {
  if (process.env.FAKE_AGY_LOCK_SCRATCH !== "1" || !process.env.TMPDIR) {
    return;
  }
  const dir = path.join(process.env.TMPDIR, "locked");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "file"), "x");
  fs.chmodSync(dir, 0o500);
}

// Puts a directory where the runner will write a file of its run directory
// (FAKE_AGY_BLOCK=result.md or events.jsonl). The test's state directory
// holds only this run's directory.
function blockRunFile(): void {
  const name = process.env.FAKE_AGY_BLOCK;
  const stateHome = process.env.XDG_STATE_HOME;
  if (!name || !stateHome) {
    return;
  }
  const runs = path.join(stateHome, "agy-plugin-cc", "runs");
  for (const run of fs.readdirSync(runs)) {
    fs.mkdirSync(path.join(runs, run, name), { recursive: true });
  }
}

function readyFile(content: string): void {
  if (process.env.FAKE_AGY_READY_FILE) {
    fs.writeFileSync(process.env.FAKE_AGY_READY_FILE, content);
  }
}

// Pipes are asynchronous on macOS; process.exit would drop pending output.
async function flush(): Promise<void> {
  await new Promise((resolve) => process.stdout.write("", resolve));
  await new Promise((resolve) => process.stderr.write("", resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdin(): Promise<void> {
  if (stdinEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve) => process.stdin.once("end", () => resolve()));
}

// Like the real CLI, a signal ends the run (and is logged); a hang step can
// change what SIGINT does.
let hangOptions: { ignoreSigint?: boolean; initOnSignal?: boolean } = {};
const onSignal = (signal: NodeJS.Signals): void => {
  signals.push(signal);
  if (hangOptions.initOnSignal && signal === "SIGINT" && !initWritten) {
    // Writes init after the runner was told to stop, then gives it time to
    // send a prompt it must not send.
    writeInit();
    setTimeout(() => process.exit(130), 500);
    return;
  }
  if (hangOptions.ignoreSigint && signal === "SIGINT") {
    return;
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

function hang(options: { ignoreSigint?: boolean; initOnSignal?: boolean }): Promise<never> {
  hangOptions = options;
  readyFile(String(process.pid));
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}

async function play(step: Step): Promise<void> {
  if (step === "init") {
    writeInit();
  } else if (step === "read") {
    await readStdin();
  } else if (step === "actions") {
    applyActions();
  } else if (step === "ready") {
    readyFile(String(process.pid));
  } else if (step === "hang") {
    await hang({});
  } else if (step === "child") {
    // A child in agy's own process group that outlives nothing on its own.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_AGY_CHILD_FILE) {
      fs.writeFileSync(process.env.FAKE_AGY_CHILD_FILE, String(child.pid ?? 0));
    }
  } else if (step === "escape") {
    // A grandchild in its own process group that keeps stdout and stderr open
    // for a few seconds, then ends on the first signal.
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    readyFile(`${process.pid} ${grandchild.pid ?? 0}`);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if ("init" in step) {
    writeInit("id" in step.init ? step.init.id : conversationId);
  } else if ("result" in step) {
    writeResult(step.result);
  } else if ("delta" in step) {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_type: "agent_response",
        state: "DONE",
        text_delta: step.delta,
      },
    });
  } else if ("raw" in step) {
    out(step.raw);
  } else if ("stderr" in step) {
    process.stderr.write(step.stderr);
  } else if ("sleep" in step) {
    await sleep(step.sleep);
  } else if ("exit" in step) {
    await flush();
    process.exit(step.exit);
  } else if ("hang" in step) {
    await hang(step.hang);
  }
}

blockRunFile();
writeProbe();
lockScratch();
const steps =
  process.env.FAKE_AGY_STEPS === undefined ? DEFAULT_STEPS : (JSON.parse(process.env.FAKE_AGY_STEPS) as Step[]);
for (const step of steps) {
  await play(step);
}
await flush();
process.exit(0);
