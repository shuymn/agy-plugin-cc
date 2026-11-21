import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { agyArgs, runAgy } from "../plugins/agy/scripts/lib/agy-exec.ts";
import { spawnAgyGroup } from "../plugins/agy/scripts/lib/process-group.ts";
import { type FakeEnv, makeFakeEnv, makeTempDir, waitForFile, waitUntilGone } from "./helpers.ts";

// Steps of the fake agy: one that waits for a signal, and one that finishes.
const SLOW = ["init", "hang"];
const OK = ["init", "read", { result: {} }];

// Runs the fake agy in-process, so the kill function can be swapped for one
// that fails the way the OS can (EPERM).
function useFake(steps: readonly unknown[]): { fake: FakeEnv; ready: string; restore: () => void } {
  const fake = makeFakeEnv({ steps });
  const ready = path.join(makeTempDir(), "ready");
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: fake.env.PATH,
    FAKE_AGY_LOG: fake.env.FAKE_AGY_LOG,
    FAKE_AGY_STEPS: fake.env.FAKE_AGY_STEPS,
    FAKE_AGY_READY_FILE: ready,
  });
  return {
    fake,
    ready,
    restore: () => {
      process.env = saved;
    },
  };
}

function failingKill(code: string) {
  return (pid: number, signal: NodeJS.Signals | 0): void => {
    void pid;
    void signal;
    throw Object.assign(new Error(`kill failed: ${code}`), { code });
  };
}

const AGY_ARGS = agyArgs({ thread: null, model: undefined, effort: undefined });
const RUN_OPTIONS = { prompt: "go", resumeId: null, eventsFile: null } as const;

// Waits without yielding to the event loop, so Node cannot reap the process,
// until it is a zombie.
function waitForZombieSync(pid: number, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (state.startsWith("Z")) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} did not become a zombie (state "${state}")`);
    }
  }
}

test("a group that cannot be signaled is reported as not reaped, within the bound", { timeout: 30_000 }, async () => {
  const { ready, restore } = useFake(SLOW);
  try {
    const group = spawnAgyGroup(AGY_ARGS, {
      cwd: makeTempDir(),
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
      kill: failingKill("EPERM"),
    });
    group.child.stdin.end("go");
    const pid = Number(await waitForFile(ready));
    const started = Date.now();
    group.stop();
    const exit = await group.exited;
    const elapsed = Date.now() - started;
    // SIGKILL at 200 ms, then 300 ms of grace; the child never exits here.
    assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
    assert.match(exit.reapError ?? "", /EPERM/);
    process.kill(pid, "SIGKILL");
    assert.ok(await waitUntilGone(pid));
  } finally {
    restore();
  }
});

// Claude Code stops a background task by signaling every descendant, so agy
// can exit just as the stop ladder starts. On macOS, signaling a group whose
// only member is an unreaped zombie fails with EPERM.
test("a group whose leader exited but is not yet reaped is not a reap failure", { timeout: 30_000 }, async () => {
  const { ready, restore } = useFake(SLOW);
  try {
    const group = spawnAgyGroup(AGY_ARGS, {
      cwd: makeTempDir(),
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
    });
    group.child.stdin.end("go");
    const pid = Number(await waitForFile(ready));
    process.kill(pid, "SIGKILL");
    waitForZombieSync(pid);
    group.stop();
    const exit = await group.exited;
    assert.equal(exit.exitSignal, "SIGKILL");
    assert.equal(exit.reapError, null);
  } finally {
    restore();
  }
});

test("an EPERM that persists after the leader is reaped is a reap failure", { timeout: 30_000 }, async () => {
  const { ready, restore } = useFake(SLOW);
  try {
    const group = spawnAgyGroup(AGY_ARGS, {
      cwd: makeTempDir(),
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
      kill: failingKill("EPERM"),
    });
    group.child.stdin.end("go");
    const pid = Number(await waitForFile(ready));
    group.stop();
    process.kill(pid, "SIGKILL");
    const exit = await group.exited;
    assert.equal(exit.exitSignal, "SIGKILL");
    assert.match(exit.reapError ?? "", /EPERM/);
  } finally {
    restore();
  }
});

// After agy is reaped, a descendant left in the group can be a zombie held
// for a while by a parent in another group.
test(
  "a group that answers EPERM after agy exits, then ESRCH before the deadline, is not a reap failure",
  { timeout: 30_000 },
  async () => {
    const { restore } = useFake(OK);
    try {
      let firstCall: number | null = null;
      let calledBeforeExit = false;
      const group = spawnAgyGroup(AGY_ARGS, {
        cwd: makeTempDir(),
        interruptGraceMs: 100,
        terminateGraceMs: 100,
        reapGraceMs: 2_000,
        kill: (pid, signal) => {
          void pid;
          void signal;
          if (group.child.exitCode === null && group.child.signalCode === null) {
            calledBeforeExit = true;
          }
          firstCall ??= Date.now();
          const code = Date.now() - firstCall < 400 ? "EPERM" : "ESRCH";
          throw Object.assign(new Error(`kill failed: ${code}`), { code });
        },
      });
      group.child.stdin.end("go");
      const exit = await group.exited;
      assert.equal(exit.exitCode, 0);
      assert.equal(calledBeforeExit, false);
      assert.equal(exit.reapError, null);
    } finally {
      restore();
    }
  },
);

test("a run whose group outlives agy is not a success", { timeout: 30_000 }, async () => {
  const { restore } = useFake(OK);
  try {
    let probes = 0;
    const result = await runAgy(AGY_ARGS, {
      cwd: makeTempDir(),
      ...RUN_OPTIONS,
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
      // agy exits; the group still looks alive and cannot be signaled.
      kill: (pid, signal) => {
        void pid;
        if (signal === 0) {
          probes += 1;
          return;
        }
        throw Object.assign(new Error("kill failed: EPERM"), { code: "EPERM" });
      },
    });
    assert.equal(result.exitCode, 0);
    assert.ok(probes > 0);
    assert.match(result.reapError ?? "", /EPERM/);
  } finally {
    restore();
  }
});

test("ESRCH from a stop signal means the group is already gone", { timeout: 30_000 }, async () => {
  const { restore } = useFake(OK);
  try {
    const result = await runAgy(AGY_ARGS, {
      cwd: makeTempDir(),
      ...RUN_OPTIONS,
      reapGraceMs: 300,
      kill: failingKill("ESRCH"),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reapError, null);
  } finally {
    restore();
  }
});

test(
  "a grandchild in another group holding the output does not count as a reap failure",
  { timeout: 30_000 },
  async () => {
    const { ready, restore } = useFake(["escape"]);
    try {
      const group = spawnAgyGroup(AGY_ARGS, {
        cwd: makeTempDir(),
        interruptGraceMs: 50,
        terminateGraceMs: 50,
        reapGraceMs: 300,
      });
      group.child.stdin.end("go");
      // The fake writes "<its pid> <grandchild pid>" once the grandchild runs.
      const [, grandchildPid] = (await waitForFile(ready)).split(" ").map(Number);
      assert.ok(grandchildPid);
      group.stop();
      const exit = await group.exited;
      assert.equal(exit.reapError, null);
      process.kill(grandchildPid, "SIGKILL");
      assert.ok(await waitUntilGone(grandchildPid));
    } finally {
      restore();
    }
  },
);

// H12
test("stopping the group stops agy and a child it started in the group", { timeout: 30_000 }, async () => {
  const { ready, restore } = useFake(["child", "init", "hang"]);
  const childFile = path.join(makeTempDir(), "child");
  process.env.FAKE_AGY_CHILD_FILE = childFile;
  try {
    const group = spawnAgyGroup(AGY_ARGS, { cwd: makeTempDir() });
    group.child.stdin.end();
    const pid = Number(await waitForFile(ready));
    const childPid = Number(await waitForFile(childFile));
    group.stop();
    const exit = await group.exited;
    assert.equal(exit.reapError, null);
    assert.equal(exit.exitCode, 130);
    assert.ok(await waitUntilGone(pid), "agy is still running");
    assert.ok(await waitUntilGone(childPid), "agy's child is still running");
  } finally {
    restore();
  }
});

test("an agy that ignores SIGINT is stopped by the ladder's SIGTERM", { timeout: 30_000 }, async () => {
  const { fake, ready, restore } = useFake(["init", { hang: { ignoreSigint: true } }]);
  try {
    const group = spawnAgyGroup(AGY_ARGS, { cwd: makeTempDir(), interruptGraceMs: 200, terminateGraceMs: 2_000 });
    group.child.stdin.end();
    const pid = Number(await waitForFile(ready));
    group.stop();
    const exit = await group.exited;
    assert.equal(exit.reapError, null);
    assert.equal(exit.exitCode, 143);
    assert.ok(await waitUntilGone(pid));
    assert.deepEqual(fake.readLog()[0]?.signals, ["SIGINT", "SIGTERM"]);
  } finally {
    restore();
  }
});
