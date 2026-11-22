// Contract with the real Antigravity CLI (the version mise pins). Runs only
// with AGY_CLI_CONTRACT=1 (`pnpm run test:cli-contract`).
//
// Each case runs agy-run against the real `agy`, through a wrapper that adds
// an invalid `--settings` value to the argv the runner builds. If that argv
// gets through agy's flag parser, agy fails on the settings value with exit 1
// before authentication, model, or network use; a rejected argv fails earlier
// with exit 2 and the flag usage.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { firstLine, makeFakeEnv, makeRepo, makeTempDir, runRunner, writePrompt } from "./helpers.ts";

const enabled = process.env.AGY_CLI_CONTRACT === "1";
const SETTINGS_ERROR = /^agy-run: agy exited 1: Error: --settings must be a JSON object/;
const FLAG_ERROR = /flags provided but not defined|Usage of agy|flag needs an argument/;

function realAgy(): string {
  const found = spawnSync("/bin/sh", ["-c", "command -v agy"], { encoding: "utf8" }).stdout.trim();
  assert.ok(found, "the Antigravity CLI must be on PATH (mise install)");
  return fs.realpathSync(found);
}

test("the real CLI accepts the argv of new and resumed runs", { skip: !enabled }, () => {
  const fake = makeFakeEnv({ agy: false });
  const wrapperDir = makeTempDir();
  fs.writeFileSync(path.join(wrapperDir, "agy"), `#!/bin/sh\nexec "${realAgy()}" --settings '{bad' "$@"\n`, {
    mode: 0o755,
  });
  fake.env.PATH = `${wrapperDir}${path.delimiter}${fake.env.PATH ?? ""}`;
  const repo = makeRepo(fake.env);

  // A recorded conversation, so the resumed form gets as far as spawning agy.
  const threadId = randomUUID();
  const threadsDir = path.join(fake.stateDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadsDir, `${threadId}.json`),
    JSON.stringify({ cwd: repo, root: repo, repo: fs.realpathSync(path.join(repo, ".git")), updatedAt: "" }),
  );

  const prompt = writePrompt();
  const model = ["--model", "gemini-3.8-flash-low", "--effort", "high"];
  const cases: string[][] = [[], [...model], ["--thread", threadId], ["--thread", threadId, ...model]];
  for (const args of cases) {
    const label = JSON.stringify(args);
    const result = runRunner(["--prompt-file", prompt, ...args], { env: fake.env, cwd: repo });
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.match(firstLine(result.stderr), SETTINGS_ERROR, label);
    assert.doesNotMatch(result.stderr, FLAG_ERROR, label);
  }
});
