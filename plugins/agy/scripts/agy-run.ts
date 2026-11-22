// agy-run: runs one Antigravity CLI (agy) turn for a calling agent. See USAGE
// below and docs/design/agy-runner.md. bin/agy-run execs this file.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { agyArgs, type AgyRunResult, cleanAgyStderr, runAgy, signalExitCode, turnFailure } from "./lib/agy-exec.ts";
import { type ChangeReport, compareTrees, formatChanges, snapshotProblem } from "./lib/changes.ts";
import { escapeLine } from "./lib/escape.ts";
import { canonicalWorkspaceRoot, GitError, gitCommonDir, gitEnv, resolveWorkspaceRoot } from "./lib/git.ts";
import type { StopTiming } from "./lib/process-group.ts";
import { appendRunLog, createRunDir, newRunId, pruneRunDirs, type RunLogEntry } from "./lib/runs.ts";
import { createScratch, removeScratch, type Scratch } from "./lib/scratch.ts";
import { type Snapshot, takeSnapshot } from "./lib/snapshot.ts";
import { checkThread, recordThread, ThreadRefusedError, type ThreadPlace } from "./lib/thread-store.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_AGY_NOT_FOUND = 3;

const USAGE = `Usage: agy-run --prompt-file <absolute file> [--cwd <dir>] [--thread <id>]
               [--model <model>] [--effort <effort>]
       agy-run --help

Runs one agy turn with the file's text as the prompt, unchanged. agy runs
with --dangerously-skip-permissions: there is no read-only mode.

Options:
  --prompt-file <file>  The prompt, as an absolute path to a UTF-8 file. Required.
  --cwd <dir>           agy's working directory. Default: the current directory.
  --thread <id>         Continue a conversation agy-run started in the same directory.
  --model <model>       Pass --model <model> to agy.
  --effort <effort>     Pass --effort <effort> to agy.
  --help                Show this help.

Output (stdout):
  run: <id>                    always first
  scratch: <dir>               agy's TMPDIR, deleted afterwards
  thread: <id>                 once agy reports the conversation
  status: ok|failed|interrupted (exit <n>)
  result: <file>               agy's final response, on exit 0 only
  cwd: <dir>
  changes: none | <n> files (...) | unknown: <reason>
  scratch left: <dir>          when the scratch directory was not deleted
Output without a status: line or a changes: line is incomplete.

Exit codes: 0 ok, 1 agy failed or ended without a usable response, 2 usage
error or refused --thread, 3 agy not on PATH, 128+n stopped by signal n.
`;

class UsageError extends Error {}

// Seams for in-process tests; the executable passes only the streams.
type RunnerIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stopTiming?: StopTiming;
  initWaitMs?: number;
};

type Request = {
  prompt: string;
  cwd: string;
  thread: string | null;
  model: string | undefined;
  effort: string | undefined;
};

function parseRequest(argv: string[]): Request | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "prompt-file": { type: "string" },
        cwd: { type: "string" },
        thread: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help === true) {
    return "help";
  }

  const promptFile = values["prompt-file"];
  if (promptFile === undefined) {
    throw new UsageError("--prompt-file is required.");
  }
  if (!path.isAbsolute(promptFile)) {
    throw new UsageError(`--prompt-file must be an absolute path: ${escapeLine(promptFile)}`);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(promptFile);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new UsageError(`cannot read --prompt-file ${escapeLine(promptFile)} (${code})`);
  }
  // The prompt travels as a JSON string, so it must be text. A leading BOM is
  // kept as part of the prompt.
  let prompt: string;
  try {
    prompt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError(`--prompt-file is not valid UTF-8: ${escapeLine(promptFile)}`);
  }
  if (prompt.trim() === "") {
    throw new UsageError(`--prompt-file is blank: ${escapeLine(promptFile)}`);
  }

  const cwd = path.resolve(process.cwd(), values.cwd ?? ".");
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(cwd).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    throw new UsageError(`--cwd is not a directory: ${escapeLine(cwd)}`);
  }

  return { prompt, cwd, thread: values.thread ?? null, model: values.model, effort: values.effort };
}

// A lookup only, so a missing agy is reported before the run starts.
function isOnPath(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      }
    } catch {
      // Not here.
    }
  }
  return false;
}

type TimedSnapshot = { snapshot: Snapshot; ms: number };

// takeSnapshot reports Git failures itself; anything else it throws, such as
// a temporary index that could not be created, is a failed snapshot too.
function safeSnapshot(root: string): TimedSnapshot {
  try {
    const started = performance.now();
    const snapshot = takeSnapshot(root);
    return { snapshot, ms: Math.round(performance.now() - started) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { snapshot: { kind: "failed", reason }, ms: 0 };
  }
}

type Outcome = { exit: number; summary: string | null; detail: string };

// The exit code and the stderr summary before result.md is written. A group
// that could not be confirmed gone takes precedence over a signal.
function outcomeOf(result: AgyRunResult, resumeId: string | null): Outcome {
  const tail = cleanAgyStderr(result.stderr);
  if (result.reapError !== null) {
    return { exit: EXIT_FAILED, summary: `process group not confirmed gone: ${result.reapError}`, detail: tail };
  }
  if (result.receivedSignal !== null) {
    // A conversation printed as thread: but not recorded cannot be continued.
    const summary = result.recordError === null ? null : `thread record not written: ${result.recordError.message}`;
    return { exit: signalExitCode(result.receivedSignal), summary, detail: "" };
  }
  const failure = turnFailure(result, resumeId, tail);
  if (failure !== null) {
    return { exit: EXIT_FAILED, summary: failure, detail: tail };
  }
  return { exit: EXIT_OK, summary: null, detail: "" };
}

function writeResult(resultFile: string, result: AgyRunResult): string | null {
  const response = result.result?.response;
  try {
    // The response as agy sent it: UTF-8, no newline added.
    fs.writeFileSync(resultFile, typeof response === "string" ? response : "", { flag: "wx" });
    return null;
  } catch (error) {
    return `result.md not written: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function statusWord(exit: number): string {
  if (exit === EXIT_OK) {
    return "ok";
  }
  return exit > 128 ? "interrupted" : "failed";
}

function oneLine(text: string): string {
  return escapeLine(text.replaceAll(/\s*\n\s*/g, " ").trim());
}

function failUsage(io: RunnerIo, message: string, exit: number): number {
  io.stderr(`agy-run: ${oneLine(message)}\n`);
  return exit;
}

// workspaceRoot: as Git reported it, for the change report.
type Prepared = { request: Request; workspaceRoot: string; place: ThreadPlace };

// Everything that may refuse the run before it starts. Returns the exit code
// when the run ends here.
function prepare(argv: string[], io: RunnerIo): Prepared | number {
  try {
    const request = parseRequest(argv);
    if (request === "help") {
      io.stdout(USAGE);
      return EXIT_OK;
    }
    // Resolved before agy starts: the thread check and record need them, and
    // a Git failure inside the init callback would stop a running turn.
    const workspaceRoot = resolveWorkspaceRoot(request.cwd);
    const place: ThreadPlace = {
      cwd: canonicalWorkspaceRoot(request.cwd),
      root: canonicalWorkspaceRoot(workspaceRoot),
      repo: gitCommonDir(request.cwd),
    };
    if (request.thread !== null) {
      checkThread(request.thread, place);
    }
    if (!isOnPath("agy")) {
      return failUsage(io, "agy was not found on PATH.", EXIT_AGY_NOT_FOUND);
    }
    return { request, workspaceRoot, place };
  } catch (error) {
    if (error instanceof UsageError || error instanceof ThreadRefusedError) {
      return failUsage(io, `${error.message}${error instanceof UsageError ? " See agy-run --help." : ""}`, EXIT_USAGE);
    }
    if (error instanceof GitError) {
      return failUsage(io, error.message, EXIT_FAILED);
    }
    throw error;
  }
}

export async function main(argv: string[], io: RunnerIo): Promise<number> {
  const prepared = prepare(argv, io);
  if (typeof prepared === "number") {
    return prepared;
  }
  const { request, workspaceRoot, place } = prepared;

  const started = Date.now();
  pruneRunDirs(started);
  const runId = newRunId(new Date(started));
  const runDir = createRunDir(runId);
  const resultFile = path.join(runDir, "result.md");
  io.stdout(`run: ${runId}\n`);

  // A snapshot failure only makes the report unknown; agy still runs.
  const baseline = safeSnapshot(workspaceRoot);
  let scratch: Scratch | null = null;
  let outcome: Outcome;
  let result: AgyRunResult | null = null;
  try {
    scratch = createScratch();
    io.stdout(`scratch: ${escapeLine(scratch.path)}\n`);
    // The same sanitized environment as the runner's Git calls, so agy works
    // on the checkout the change report measures.
    const env = { ...gitEnv(), TMPDIR: scratch.path };
    result = await runAgy(agyArgs(request), {
      cwd: request.cwd,
      env,
      prompt: request.prompt,
      resumeId: request.thread,
      eventsFile: path.join(runDir, "events.jsonl"),
      onArchiveError: (error) => io.stderr(`agy-run: events not saved: ${oneLine(error.message)}\n`),
      ...io.stopTiming,
      ...(io.initWaitMs === undefined ? {} : { initWaitMs: io.initWaitMs }),
      onInit: (conversationId) => {
        io.stdout(`thread: ${conversationId}\n`);
        recordThread(conversationId, place);
      },
    });
    outcome = outcomeOf(result, request.thread);
  } catch (error) {
    // Includes AgyStartError: after the run started, a spawn failure is exit 1.
    outcome = { exit: EXIT_FAILED, summary: error instanceof Error ? error.message : String(error), detail: "" };
  }

  const reapError = result?.reapError ?? null;
  // An interruption or a group not confirmed gone decides the report even
  // when there is no baseline tree to name.
  const baseTree = baseline.snapshot.kind === "tree" ? baseline.snapshot.tree : null;
  let report: ChangeReport;
  let finalMs: number | undefined;
  if (reapError !== null) {
    report = { kind: "unknown", category: "reap-error", reason: "reap-error", baseline: baseTree };
  } else if (result?.receivedSignal) {
    report = { kind: "unknown", category: "interrupted", reason: "interrupted", baseline: baseTree };
  } else if (baseline.snapshot.kind !== "tree") {
    report = snapshotProblem(baseline.snapshot, "baseline", null);
  } else {
    const final = safeSnapshot(workspaceRoot);
    finalMs = final.ms;
    report =
      final.snapshot.kind === "tree"
        ? compareTrees(workspaceRoot, baseline.snapshot.tree, final.snapshot.tree)
        : snapshotProblem(final.snapshot, "final", baseline.snapshot.tree);
  }

  // Only a run that was not interrupted and whose group was reaped gets here
  // with exit 0, so a signal exit code is never replaced by a write failure.
  if (outcome.exit === EXIT_OK && result !== null) {
    const writeFailure = writeResult(resultFile, result);
    if (writeFailure !== null) {
      outcome = { exit: EXIT_FAILED, summary: writeFailure, detail: cleanAgyStderr(result.stderr) };
    }
  }

  // agy may still be using the scratch directory after a reapError.
  const scratchLeft = scratch !== null && (reapError !== null || !removeScratch(scratch));

  if (outcome.summary !== null) {
    io.stderr(`agy-run: ${oneLine(outcome.summary)}\n${outcome.detail ? `${outcome.detail}\n` : ""}`);
  }

  const entry: RunLogEntry = {
    run: runId,
    time: new Date(started).toISOString(),
    continued: request.thread !== null,
    exit: outcome.exit,
    durationMs: Date.now() - started,
    changes: report.kind === "changes" ? report.entries.length : null,
    ...(report.kind === "unknown" ? { unknown: report.category } : {}),
    snapshotMs: { baseline: baseline.ms, ...(finalMs === undefined ? {} : { final: finalMs }) },
  };
  try {
    appendRunLog(entry);
  } catch (error) {
    io.stderr(`agy-run: could not append to the run log: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const lines = [
    `status: ${statusWord(outcome.exit)} (exit ${outcome.exit})`,
    ...(outcome.exit === EXIT_OK ? [`result: ${escapeLine(resultFile)}`] : []),
    `cwd: ${escapeLine(request.cwd)}`,
    ...formatChanges(report, workspaceRoot, runDir),
    ...(scratchLeft && scratch !== null ? [`scratch left: ${escapeLine(scratch.path)}`] : []),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return outcome.exit;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    process.stderr.write(`agy-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
