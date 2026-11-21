import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { firstLine, git, makeFakeEnv, makeRepo, makeTempDir, outputLine, runRunner, writePrompt } from "./helpers.ts";

type Record = { cwd: string; root: string; repo: string | null; updatedAt: string };

function threadRecord(stateDir: string, thread: string): Record {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "threads", `${thread}.json`), "utf8")) as Record;
}

// H7
test("--thread continues a conversation from the directory it started in", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const sub = path.join(repo, "src");
  fs.mkdirSync(sub);
  const prompt = writePrompt();

  const first = runRunner(["--prompt-file", prompt, "--cwd", sub], { env: fake.env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  const record = threadRecord(fake.stateDir, thread);
  assert.equal(record.cwd, sub);
  assert.equal(record.root, repo);
  assert.equal(record.repo, fs.realpathSync(path.join(repo, ".git")));

  const resumed = runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd: sub });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(outputLine(resumed.stdout, "thread"), thread);
  const [, call] = fake.readLog();
  assert.equal(call?.cwd, sub);
  assert.equal(call?.argv[call.argv.indexOf("--conversation") + 1], thread);
  const touched = threadRecord(fake.stateDir, thread);
  assert.deepEqual({ ...touched, updatedAt: "" }, { ...record, updatedAt: "" });
  assert.ok(touched.updatedAt >= record.updatedAt);
});

test("--thread from a sibling directory, another worktree, another repository, or an unknown or invalid id exits 2 before agy starts", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const sub = path.join(repo, "a");
  const sibling = path.join(repo, "b");
  fs.mkdirSync(sub);
  fs.mkdirSync(sibling);
  const worktree = path.join(makeTempDir(), "wt");
  git(repo, ["worktree", "add", "-q", "-b", "wt", worktree], fake.env);
  fs.mkdirSync(path.join(worktree, "a"));
  const other = makeRepo(fake.env);
  const prompt = writePrompt();
  const first = runRunner(["--prompt-file", prompt, "--cwd", sub], { env: fake.env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";

  for (const cwd of [sibling, repo, path.join(worktree, "a"), worktree, other]) {
    const result = runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd });
    assert.equal(result.status, 2, cwd);
    assert.equal(result.stdout, "", cwd);
    assert.match(firstLine(result.stderr), new RegExp(`started in ${sub} .*Pass --cwd ${sub},`), cwd);
  }

  const unknown = runRunner(["--prompt-file", prompt, "--thread", "0000-unknown"], { env: fake.env, cwd: repo });
  assert.equal(unknown.status, 2);
  assert.match(firstLine(unknown.stderr), /not started by agy-run.*agy --conversation 0000-unknown/);

  for (const id of ["../x", "a_b", "x".repeat(129), ""]) {
    const invalid = runRunner(["--prompt-file", prompt, "--thread", id], { env: fake.env, cwd: repo });
    assert.equal(invalid.status, 2, id);
    assert.match(firstLine(invalid.stderr), /invalid conversation id/, id);
  }
  assert.equal(fake.readLog().length, 1);
});

test("a conversation recorded outside Git continues only there, and only while the directory stays outside Git", () => {
  const fake = makeFakeEnv();
  const plain = makeTempDir();
  const prompt = writePrompt();
  const first = runRunner(["--prompt-file", prompt], { env: fake.env, cwd: plain });
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  assert.equal(threadRecord(fake.stateDir, thread).repo, null);
  assert.equal(runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd: plain }).status, 0);
  assert.equal(
    runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd: makeTempDir() }).status,
    2,
  );

  // The same directory, now a repository: the record no longer matches.
  git(plain, ["init", "-q", "-b", "main"], fake.env);
  const result = runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd: plain });
  assert.equal(result.status, 2);
  assert.match(firstLine(result.stderr), new RegExp(`started in ${plain}, `));
  assert.equal(fake.readLog().length, 2);
});
