// Runs one `agy` print-mode turn over stream-json and collects what the runner
// needs to judge it: the init and result events, the AGY_ERROR and jetski
// lines on stderr, and whether the prompt was sent. The prompt is sent only
// after the first init was accepted and while the run is not stopping.

import fs from "node:fs";

import { escapeLine } from "./escape.ts";
import { isRecord, type JsonObject } from "./json.ts";
import { type GroupExit, spawnAgyGroup, type StopTiming } from "./process-group.ts";
import { isValidThreadId } from "./thread-store.ts";

export { AgyStartError } from "./process-group.ts";

const STDERR_TAIL_LINES = 40;
const MAX_STDERR_CHARS = 1_000_000;
// Longer stderr lines are scanned by their head only.
const MAX_SCANNED_LINE_CHARS = 64 * 1024;
// How long agy may take to report its conversation before it is stopped.
export const INIT_WAIT_MS = 120_000;

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15 };

const AGY_ERROR_PREFIX = "AGY_ERROR:";
const JETSKI_PREFIX = "jetski: no output produced";

export type AgyRunOptions = StopTiming & {
  cwd: string;
  // The whole environment of agy; process.env when omitted.
  env?: NodeJS.ProcessEnv;
  // The prompt text, sent as one stream-json user message.
  prompt: string;
  // The conversation the run resumes, or null for a new one.
  resumeId: string | null;
  // stdout is appended here byte for byte; null: not archived.
  eventsFile: string | null;
  onArchiveError?: (error: Error) => void;
  // Runs for an accepted first init, before the prompt is sent. An exception
  // here stops agy and is returned as recordError.
  onInit?: (conversationId: string) => void;
  initWaitMs?: number;
};

// The fields of the result event the runner reads, as agy sent them.
export type AgyResult = {
  conversationId: unknown;
  status: unknown;
  response: unknown;
  error: unknown;
  finishedReason: unknown;
};

export type AgyRunResult = GroupExit & {
  // The bounded tail of agy's stderr.
  stderr: string;
  initCount: number;
  resultCount: number;
  // The id of the accepted first init, or null.
  conversationId: string | null;
  // The first init's id when it failed the pattern (escaped for display).
  invalidInitId: string | null;
  // The first init's id when it differed from the resumed conversation.
  staleInitId: string | null;
  recordError: Error | null;
  initTimedOut: boolean;
  initWaitMs: number;
  promptWritten: boolean;
  resultBeforePrompt: boolean;
  result: AgyResult | null;
  agyErrorLine: string | null;
  jetskiLine: string | null;
};

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 15);
}

// The stream-json argv of one turn. `-p=` comes last and with `=`: `-p` takes
// the next argument as its value.
export function agyArgs(request: {
  thread: string | null;
  model: string | undefined;
  effort: string | undefined;
}): string[] {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    ...(request.thread === null ? [] : ["--conversation", request.thread]),
    ...(request.model === undefined ? [] : ["--model", request.model]),
    ...(request.effort === undefined ? [] : ["--effort", request.effort]),
    "-p=",
  ];
}

// The one stdin line of a turn. JSON.stringify escapes newlines, so the line
// is one NDJSON record.
export function promptLine(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

export function cleanAgyStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-STDERR_TAIL_LINES)
    .join("\n");
}

function lastLine(cleanedTail: string): string {
  return cleanedTail.split("\n").findLast(Boolean) ?? "";
}

function exitText(result: AgyRunResult): string {
  return result.exitCode === null ? `signal ${result.exitSignal ?? "unknown"}` : String(result.exitCode);
}

function withLastLine(text: string, cleanedTail: string): string {
  const last = lastLine(cleanedTail);
  return last ? `${text}: ${last}` : text;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function display(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "missing" : JSON.stringify(value);
}

// The short_error of an AGY_ERROR line, else its reason, else the raw line.
function agyErrorReason(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line.slice(line.indexOf(AGY_ERROR_PREFIX) + AGY_ERROR_PREFIX.length));
    if (isRecord(parsed)) {
      if (nonEmptyString(parsed.short_error)) {
        return parsed.short_error;
      }
      if (nonEmptyString(parsed.reason)) {
        return parsed.reason;
      }
    }
  } catch {
    // Not JSON: the raw line.
  }
  return line;
}

// Why the turn is not a completed answer of the requested conversation, or
// null when it is. The process group's own failures and signals are judged
// by the caller first; this covers everything else, in this order.
export function turnFailure(result: AgyRunResult, resumeId: string | null): string | null {
  const tail = cleanAgyStderr(result.stderr);
  const turn = result.result;
  if (result.invalidInitId !== null) {
    return `invalid conversation id from agy: ${result.invalidInitId}`;
  }
  if (result.recordError !== null) {
    return `thread record not written: ${result.recordError.message}`;
  }
  if (result.staleInitId !== null) {
    return `stale conversation: requested ${resumeId ?? ""}, agy started ${result.staleInitId}`;
  }
  if (turn !== null && nonEmptyString(turn.error)) {
    return turn.error;
  }
  if (result.agyErrorLine !== null) {
    return agyErrorReason(result.agyErrorLine);
  }
  if (
    turn !== null &&
    turn.finishedReason !== undefined &&
    turn.finishedReason !== null &&
    turn.finishedReason !== ""
  ) {
    return `finished_reason: ${display(turn.finishedReason)}`;
  }
  if (turn !== null && turn.status !== "SUCCESS") {
    return `status: ${display(turn.status)}`;
  }
  if (result.initTimedOut) {
    return `no init event within ${result.initWaitMs / 1000}s`;
  }
  if (result.initCount === 0 && result.resultCount === 0) {
    return withLastLine(`agy exited ${exitText(result)}`, tail);
  }
  if (result.initCount === 0) {
    return "no init event";
  }
  if (result.initCount > 1) {
    return "multiple init events";
  }
  if (result.resultCount > 1) {
    return "multiple result events";
  }
  if (turn !== null && turn.conversationId !== result.conversationId) {
    return `result conversation ${escapeLine(display(turn.conversationId))} differs from init ${result.conversationId ?? ""}`;
  }
  if (result.resultBeforePrompt) {
    return "result before prompt";
  }
  if (result.jetskiLine !== null) {
    return result.jetskiLine;
  }
  if (turn !== null && !nonEmptyString(turn.response)) {
    return "empty response";
  }
  if (turn === null) {
    return withLastLine(`no result event (agy exited ${exitText(result)})`, tail);
  }
  if (result.exitCode !== 0) {
    return `agy exited ${exitText(result)}`;
  }
  return null;
}

function asObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// Splits a byte stream into lines, accepting lines of any length.
function lineSplitter(onLine: (line: Buffer) => void): { push: (chunk: Buffer) => void; end: () => void } {
  let pending: Buffer[] = [];
  return {
    push: (chunk) => {
      let start = 0;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, index));
        onLine(Buffer.concat(pending));
        pending = [];
        start = index + 1;
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start));
      }
    },
    end: () => {
      if (pending.length > 0) {
        onLine(Buffer.concat(pending));
        pending = [];
      }
    },
  };
}

export async function runAgy(args: readonly string[], options: AgyRunOptions): Promise<AgyRunResult> {
  const initWaitMs = options.initWaitMs ?? INIT_WAIT_MS;
  let promptWritten = false;

  // A run that is stopping never sends the prompt: stdin is closed unwritten.
  const closeStdinUnwritten = (): void => {
    if (!promptWritten && !group.child.stdin.writableEnded) {
      group.child.stdin.end();
    }
  };
  const group = spawnAgyGroup(args, { ...options, beforeStop: () => closeStdinUnwritten() });
  const { child } = group;

  let stderr = "";
  let initCount = 0;
  let resultCount = 0;
  let conversationId: string | null = null;
  let invalidInitId: string | null = null;
  let staleInitId: string | null = null;
  let recordError: Error | null = null;
  let initTimedOut = false;
  let resultBeforePrompt = false;
  let result: AgyResult | null = null;
  let agyErrorLine: string | null = null;
  let jetskiLine: string | null = null;
  let archiving = options.eventsFile !== null;

  const initTimer = setTimeout(() => {
    if (initCount === 0 && child.exitCode === null && child.signalCode === null) {
      initTimedOut = true;
      group.stop();
    }
  }, initWaitMs);

  const onFirstInit = (event: JsonObject): void => {
    clearTimeout(initTimer);
    const id = event.conversation_id;
    if (typeof id !== "string" || !isValidThreadId(id)) {
      invalidInitId = typeof id === "string" ? escapeLine(id) : display(id);
      group.stop();
      return;
    }
    if (options.resumeId !== null && id !== options.resumeId) {
      staleInitId = id;
      group.stop();
      return;
    }
    if (group.isStopping()) {
      return;
    }
    try {
      options.onInit?.(id);
    } catch (error) {
      recordError = toError(error);
      group.stop();
      return;
    }
    conversationId = id;
    promptWritten = true;
    // A child that exits before reading all input closes the pipe; EPIPE is
    // not an error of its own.
    child.stdin.end(promptLine(options.prompt));
  };

  const onEvent = (event: JsonObject): void => {
    if (event.event === "init") {
      initCount += 1;
      if (initCount === 1) {
        onFirstInit(event);
      }
    } else if (event.event === "result") {
      resultCount += 1;
      if (!promptWritten) {
        resultBeforePrompt = true;
      }
      if (resultCount === 1) {
        const payload = asObject(event.result);
        result = {
          conversationId: payload?.conversation_id,
          status: payload?.status,
          response: payload?.response,
          error: payload?.error,
          finishedReason: payload?.finished_reason,
        };
      }
    }
  };

  const stdout = lineSplitter((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const event = asObject(parsed);
    if (event !== null) {
      onEvent(event);
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (archiving && options.eventsFile !== null) {
      try {
        fs.appendFileSync(options.eventsFile, chunk);
      } catch (error) {
        archiving = false;
        options.onArchiveError?.(toError(error));
      }
    }
    stdout.push(chunk);
  });
  child.stdout.on("end", () => stdout.end());

  // stderr is scanned line by line, apart from the bounded tail.
  const scanLine = (line: string): void => {
    const text = line.trim();
    if (agyErrorLine === null && text.startsWith(AGY_ERROR_PREFIX)) {
      agyErrorLine = text;
    } else if (jetskiLine === null && text.startsWith(JETSKI_PREFIX)) {
      jetskiLine = text;
    }
  };
  let partial = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    const parts = (partial + chunk).split("\n");
    partial = (parts.pop() ?? "").slice(0, MAX_SCANNED_LINE_CHARS);
    for (const part of parts) {
      scanLine(part);
    }
  });
  child.stderr.on("end", () => {
    if (partial) {
      scanLine(partial);
      partial = "";
    }
  });

  // agy that exits before any init gets stdin closed unwritten.
  child.on("exit", () => closeStdinUnwritten());

  try {
    const exit = await group.exited;
    return {
      ...exit,
      stderr,
      initCount,
      resultCount,
      conversationId,
      invalidInitId,
      staleInitId,
      recordError,
      initTimedOut,
      initWaitMs,
      promptWritten,
      resultBeforePrompt,
      result,
      agyErrorLine,
      jetskiLine,
    };
  } finally {
    clearTimeout(initTimer);
  }
}
