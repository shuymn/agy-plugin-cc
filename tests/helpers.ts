import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export const ROOT = path.resolve(import.meta.dirname, "..");

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
