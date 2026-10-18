import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("TEMP: emit generated lockfile to action logs for commit", () => {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: base, timeout: 120000, stdio: "pipe"
  });
  const raw = readFileSync(path.join(base,"package-lock.json"), "utf8");
  console.log("LOCKFILE_BEGIN_" + Buffer.from(raw).toString("base64") + "_LOCKFILE_END");
});
