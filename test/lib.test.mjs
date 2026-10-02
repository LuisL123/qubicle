import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, checksGreen, protectedHits } from "../bin/lib.mjs";

// ---------- parseArgs ----------

test("parseArgs: empty argv", () => {
  assert.deepEqual(parseArgs([]), { opts: {}, pos: [] });
});

test("parseArgs: positionals only", () => {
  assert.deepEqual(parseArgs(["ask", "hello"]), { opts: {}, pos: ["ask", "hello"] });
});

test("parseArgs: a flag takes the next word as its value", () => {
  assert.deepEqual(parseArgs(["--n", "20"]), { opts: { n: "20" }, pos: [] });
});

test("parseArgs: a trailing flag with no value is true", () => {
  assert.deepEqual(parseArgs(["--verbose"]), { opts: { verbose: true }, pos: [] });
});

test("parseArgs: a flag followed by another flag stays boolean", () => {
  assert.deepEqual(parseArgs(["--a", "--b"]), { opts: { a: true, b: true }, pos: [] });
});

test("parseArgs: a flag followed by a flag and a value", () => {
  assert.deepEqual(parseArgs(["--a", "--b", "v"]), { opts: { a: true, b: "v" }, pos: [] });
});

test("parseArgs: options and positionals mix", () => {
  assert.deepEqual(parseArgs(["ask", "hello world", "--level", "urgent"]), {
    opts: { level: "urgent" },
    pos: ["ask", "hello world"],
  });
});

test("parseArgs: the last repeat of a flag wins", () => {
  assert.deepEqual(parseArgs(["--n", "1", "--n", "2"]).opts, { n: "2" });
});

test("parseArgs: an empty string is a value, not a boolean", () => {
  assert.deepEqual(parseArgs(["--n", ""]).opts, { n: "" });
});

test("parseArgs: a single dash is positional", () => {
  assert.deepEqual(parseArgs(["-n"]), { opts: {}, pos: ["-n"] });
});

test("parseArgs: --flag=value is one key, not split", () => {
  assert.deepEqual(parseArgs(["--a=1"]), { opts: { "a=1": true }, pos: [] });
});

test("parseArgs: a bare -- is a flag with an empty key", () => {
  assert.deepEqual(parseArgs(["--"]), { opts: { "": true }, pos: [] });
  assert.deepEqual(parseArgs(["--", "x"]), { opts: { "": "x" }, pos: [] });
});

// ---------- checksGreen ----------

// Shape of a GitHub CheckRun entry in statusCheckRollup.
const checkRun = (over = {}) => ({ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", ...over });
// Shape of a legacy StatusContext entry in statusCheckRollup.
const legacy = (over = {}) => ({ context: "ci/circleci", state: "SUCCESS", ...over });

test("checksGreen: no rollup is green", () => {
  assert.deepEqual(checksGreen(undefined), []);
  assert.deepEqual(checksGreen(null), []);
});

test("checksGreen: an empty rollup is green", () => {
  assert.deepEqual(checksGreen([]), []);
});

test("checksGreen: success, neutral and skipped are all green", () => {
  assert.deepEqual(
    checksGreen([
      checkRun({ name: "build", conclusion: "SUCCESS" }),
      checkRun({ name: "lint", conclusion: "NEUTRAL" }),
      checkRun({ name: "docs", conclusion: "SKIPPED" }),
    ]),
    [],
  );
});

test("checksGreen: a finished legacy context in SUCCESS is green", () => {
  assert.deepEqual(checksGreen([legacy()]), []);
});

test("checksGreen: an unfinished check run is reported with its status", () => {
  assert.deepEqual(checksGreen([checkRun({ name: "ci", status: "IN_PROGRESS" })]), ["ci: in_progress"]);
  assert.deepEqual(checksGreen([checkRun({ name: "ci", status: "QUEUED" })]), ["ci: queued"]);
  assert.deepEqual(checksGreen([checkRun({ name: "ci", status: "WAITING" })]), ["ci: waiting"]);
});

test("checksGreen: bad conclusions are reported, lowercased", () => {
  assert.deepEqual(
    checksGreen([
      checkRun({ name: "test", conclusion: "FAILURE" }),
      checkRun({ name: "deploy", conclusion: "CANCELLED" }),
      checkRun({ name: "slow", conclusion: "TIMED_OUT" }),
      checkRun({ name: "gated", conclusion: "ACTION_REQUIRED" }),
      checkRun({ name: "stale", conclusion: "STALE" }),
      checkRun({ name: "boot", conclusion: "STARTUP_FAILURE" }),
    ]),
    [
      "test: failure",
      "deploy: cancelled",
      "slow: timed_out",
      "gated: action_required",
      "stale: stale",
      "boot: startup_failure",
    ],
  );
});

test("checksGreen: a non-SUCCESS legacy state is reported with its context", () => {
  assert.deepEqual(checksGreen([legacy({ context: "ci/circleci", state: "FAILURE" })]), ["ci/circleci: failure"]);
  assert.deepEqual(checksGreen([legacy({ context: "ci/travis", state: "PENDING" })]), ["ci/travis: pending"]);
  assert.deepEqual(checksGreen([legacy({ context: "ci/other", state: "ERROR" })]), ["ci/other: error"]);
});

test("checksGreen: entries with no typename and no state are ignored", () => {
  assert.deepEqual(checksGreen([{}, { foo: 1 }, { state: "" }]), []);
});

test("checksGreen: reports in the order the rollup lists them", () => {
  assert.deepEqual(
    checksGreen([
      checkRun({ name: "a", conclusion: "FAILURE" }),
      checkRun({ name: "b" }),
      legacy({ context: "c", state: "PENDING" }),
    ]),
    ["a: failure", "c: pending"],
  );
});

test("checksGreen: a completed check run with no conclusion throws", () => {
  // Characterizes a latent crash: conclusion.toLowerCase() is unguarded, so a
  // COMPLETED run with a null conclusion throws instead of being reported.
  // GitHub always sends a conclusion for a completed run, so a rollup that hits
  // this is malformed; failing loudly beats reporting it green.
  assert.throws(() => checksGreen([checkRun({ conclusion: null })]), TypeError);
});

// ---------- protectedHits ----------

test("protectedHits: exact files and directory prefixes", () => {
  const pats = ["rig.yaml", "CULTURE.md", "agents/"];
  assert.deepEqual(
    protectedHits(["rig.yaml", "agents/orchestrator/role.md", "README.md", "test/x.mjs"], pats),
    ["rig.yaml", "agents/orchestrator/role.md"],
  );
});

test("protectedHits: no false prefix match without the slash", () => {
  assert.deepEqual(protectedHits(["rig.yaml.bak", "agentsx/a"], ["rig.yaml", "agents/"]), []);
});

test("protectedHits: empty inputs", () => {
  assert.deepEqual(protectedHits([], ["rig.yaml"]), []);
  assert.deepEqual(protectedHits(["rig.yaml"], undefined), []);
});
