import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeFakeEnv, makeTempDir, WRAPPER } from "./helpers.ts";

// A copy of the plugin layout whose runner prints where it runs from and its
// arguments, so the test can tell which scripts/agy-run.ts the wrapper ran.
function fakePlugin(): string {
  const root = path.join(makeTempDir(), "plugin");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(WRAPPER, path.join(root, "bin", "agy-run"));
  fs.chmodSync(path.join(root, "bin", "agy-run"), 0o755);
  fs.writeFileSync(
    path.join(root, "scripts", "agy-run.ts"),
    "process.stdout.write(JSON.stringify({ file: import.meta.filename, args: process.argv.slice(2), pid: process.pid }));\n",
  );
  return root;
}

// H1
test("the wrapper runs scripts/agy-run.ts of its own plugin through a chain of symlinks", () => {
  const fake = makeFakeEnv();
  const root = fakePlugin();
  const links = makeTempDir();
  // An absolute link to a relative link to the wrapper.
  fs.symlinkSync(path.relative(links, path.join(root, "bin", "agy-run")), path.join(links, "relative"));
  fs.symlinkSync(path.join(links, "relative"), path.join(links, "agy-run"));
  const args = ["--prompt-file", "/a b/it's.md", "", "-x"];
  for (const entry of [path.join(root, "bin", "agy-run"), path.join(links, "agy-run")]) {
    const result = spawnSync(entry, args, { env: fake.env, cwd: makeTempDir(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const ran = JSON.parse(result.stdout) as { file: string; args: string[]; pid: number };
    assert.equal(ran.file, path.join(fs.realpathSync(root), "scripts", "agy-run.ts"));
    assert.deepEqual(ran.args, args);
    // exec: node replaced the shell, so signals sent to the wrapper reach the runner.
    assert.equal(ran.pid, result.pid);
  }
});

test("the shipped wrapper starts the runner", () => {
  const fake = makeFakeEnv();
  const link = path.join(makeTempDir(), "agy-run");
  fs.symlinkSync(WRAPPER, link);
  const result = spawnSync(link, ["--help"], { env: fake.env, cwd: makeTempDir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: agy-run /);
});

test("an exported CDPATH does not change where the wrapper finds the runner", () => {
  const fake = makeFakeEnv();
  const root = fakePlugin();
  const parent = path.dirname(root);
  // A relative symlink next to the plugin, and CDPATH entries that `cd` would search.
  fs.symlinkSync(path.join("plugin", "bin", "agy-run"), path.join(parent, "agy-run"));
  const env = { ...fake.env, CDPATH: `.:${parent}:${path.join(root, "bin")}` };
  for (const entry of ["plugin/bin/agy-run", "./agy-run"]) {
    const result = spawnSync(entry, ["--help"], { env, cwd: parent, encoding: "utf8" });
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
    const ran = JSON.parse(result.stdout) as { file: string };
    assert.equal(ran.file, path.join(fs.realpathSync(root), "scripts", "agy-run.ts"));
  }
});
