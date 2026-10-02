import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "qb.mjs");
const run = (args) => execFileSync(process.execPath, [QB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("qb: --help prints the usage block and exits 0", () => {
  const out = run(["--help"]);
  assert.match(out, /qb: Qubicle helper/);
  assert.match(out, /qb wt <owner\/repo> <branch>/);
});

test("qb: an unknown command exits 1 and points at help", () => {
  assert.throws(() => run(["definitely-not-a-command"]), (e) => {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /unknown command "definitely-not-a-command"/);
    return true;
  });
});
