import fs from "node:fs";
import path from "node:path";

import { stateDir, writeFileAtomic } from "./env.ts";
import { isRecord } from "./json.ts";

// The agy conversations agy-run started, one file per conversation:
//   <state>/threads/<conversation id>.json  {cwd, root, repo, updatedAt}
// cwd is the canonical directory agy was spawned in, root the canonical
// workspace root (only shown in refusals), and repo the real path of the
// common Git directory, or null outside Git. A resumed conversation keeps
// working in the directory it started in, so it may be continued only from
// that same directory of the same repository. One file per conversation,
// written atomically, so parallel runs never drop each other's records.

const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

type ThreadRecord = { cwd: string; root: string; repo: string | null; updatedAt: string };

// Where a conversation runs: the canonical spawn directory, the canonical
// workspace root, and the common Git directory (null outside Git).
export type ThreadPlace = { cwd: string; root: string; repo: string | null };

// A --thread that may not be continued here; the message says why and what to
// do instead.
export class ThreadRefusedError extends Error {
  override name = "ThreadRefusedError";
}

function recordPath(threadId: string): string {
  return path.join(stateDir(), "threads", `${threadId}.json`);
}

export function isValidThreadId(threadId: string): boolean {
  return THREAD_ID_PATTERN.test(threadId);
}

// Writes the record, or refreshes its updatedAt on a resume. Throws when the
// id is not safe as a file name or the record cannot be written.
export function recordThread(threadId: string, place: ThreadPlace): void {
  if (!isValidThreadId(threadId)) {
    throw new Error(`invalid conversation id ${JSON.stringify(threadId)}`);
  }
  const record: ThreadRecord = { ...place, updatedAt: new Date().toISOString() };
  writeFileAtomic(recordPath(threadId), `${JSON.stringify(record)}\n`);
}

// updatedAt is written for inspection but not read back.
function readRecord(threadId: string): { cwd: string; repo: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath(threadId), "utf8"));
    if (isRecord(parsed) && typeof parsed.cwd === "string") {
      return { cwd: parsed.cwd, repo: typeof parsed.repo === "string" ? parsed.repo : null };
    }
  } catch {
    // A missing or unreadable record means there is nothing to continue.
  }
  return null;
}

// Checks that `threadId` may be continued from `place`, or throws
// ThreadRefusedError: the record must exist, and both its spawn directory and
// its common Git directory must equal the current ones (null equals null).
export function checkThread(threadId: string, place: ThreadPlace): void {
  if (!isValidThreadId(threadId)) {
    throw new ThreadRefusedError(`cannot continue: invalid conversation id ${JSON.stringify(threadId)}.`);
  }
  const recorded = readRecord(threadId);
  if (recorded === null) {
    throw new ThreadRefusedError(
      `cannot continue: conversation ${threadId} was not started by agy-run. Use \`agy --conversation ${threadId}\` in a terminal instead.`,
    );
  }
  if (recorded.cwd !== place.cwd || recorded.repo !== place.repo) {
    const where = recorded.repo === null ? recorded.cwd : `${recorded.cwd} (repository ${recorded.repo})`;
    throw new ThreadRefusedError(
      `cannot continue: conversation ${threadId} started in ${where}, and agy keeps working there. Pass --cwd ${recorded.cwd}, or start a new conversation.`,
    );
  }
}
