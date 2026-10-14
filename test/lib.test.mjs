import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, checksGreen, protectedHits, missedDigest, staleDigests, quietSinceLastDigest, delegatedMergeProblems, reaskChurn } from "../bin/lib.mjs";

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

// ---------- digests ----------

test("missedDigest: morning missed after 9:15", () => {
  assert.equal(missedDigest("2026-10-06 11:34", [".2026-10-05T0900-morning.prompt.md"]), "morning");
});

test("missedDigest: morning already sent today", () => {
  assert.equal(missedDigest("2026-10-06 09:40", [".2026-10-06T0900-morning.prompt.md"]), null);
});

test("missedDigest: waits for launchd before 9:15, gives up at noon", () => {
  assert.equal(missedDigest("2026-10-06 09:05", []), null);
  assert.equal(missedDigest("2026-10-06 12:00", []), null);
});

test("missedDigest: evening window", () => {
  assert.equal(missedDigest("2026-10-06 19:30", []), "evening");
  assert.equal(missedDigest("2026-10-06 19:30", [".2026-10-06T1900-evening.prompt.md"]), null);
});

test("staleDigests: only old prompts without output", () => {
  const prompts = [
    { name: ".2026-10-05T1900-evening.prompt.md", ageMin: 45 },
    { name: ".2026-10-05T1449-pulse.prompt.md", ageMin: 50 },
    { name: ".2026-10-06T1434-pulse.prompt.md", ageMin: 5 },
    { name: ".2026-10-01T0900-morning.prompt.md", ageMin: 9000 },
  ];
  const files = ["2026-10-05T1449-pulse.md"];
  assert.deepEqual(staleDigests(prompts, files), ["2026-10-05T1900-evening"]);
});

test("quietSinceLastDigest", () => {
  assert.equal(quietSinceLastDigest([{ level: "chat" }, { level: "digest" }, { level: "mode" }]), true);
  assert.equal(quietSinceLastDigest([{ level: "digest" }, { level: "decided" }]), false);
  assert.equal(quietSinceLastDigest([{ level: "chat" }]), false);
});

// ---------- delegated merge ----------

test("checksGreen: ignore skips a named check run and a legacy context, nothing else", () => {
  const rollup = [
    { __typename: "CheckRun", name: "Analyze (python)", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
    { context: "ci/legacy", state: "FAILURE" },
  ];
  assert.deepEqual(checksGreen(rollup, ["Analyze (python)"]), ["test: failure", "ci/legacy: failure"]);
  assert.deepEqual(checksGreen(rollup, ["Analyze (python)", "test", "ci/legacy"]), []);
  assert.deepEqual(checksGreen(rollup), ["Analyze (python): failure", "test: failure", "ci/legacy: failure"]);
});

const ORCH = "lead-orchestrator@qubicle", REV = "review-codex@qubicle", HEAD = "a".repeat(40);
const good = () => ({
  seat: ORCH, orchestrator: ORCH, reviewer: REV,
  info: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] },
  approval: { by: REV, sha: HEAD }, files: ["src/a.py"], ignore: ["Analyze (python)"], protectedPatterns: [],
});

test("delegatedMergeProblems: the orchestrator, an approval of the current head and green checks pass", () => {
  assert.deepEqual(delegatedMergeProblems(good()), []);
});

test("delegatedMergeProblems: any other seat is refused", () => {
  for (const seat of ["build-claude@qubicle", "review-codex@qubicle", "", undefined]) {
    const bad = delegatedMergeProblems({ ...good(), seat });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /only lead-orchestrator@qubicle merges delegated repos/);
  }
});

test("delegatedMergeProblems: an approval for an older commit is refused after a push", () => {
  const g = good(); g.info.headRefOid = "b".repeat(40);
  const bad = delegatedMergeProblems(g);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /approval is for aaaaaaa but the PR head is now bbbbbbb/);
});

test("delegatedMergeProblems: no approval, a non-reviewer approval and an approval with no SHA are refused", () => {
  assert.match(delegatedMergeProblems({ ...good(), approval: null })[0], /no approval on record/);
  assert.match(delegatedMergeProblems({ ...good(), approval: { by: "luis", sha: HEAD } })[0], /approval is by luis, not review-codex@qubicle/);
  assert.match(delegatedMergeProblems({ ...good(), approval: { by: REV } })[0], /no commit SHA/);
});

test("delegatedMergeProblems: draft, closed and unmergeable PRs are refused", () => {
  const g = good(); g.info.isDraft = true; g.info.state = "CLOSED"; g.info.mergeable = "CONFLICTING";
  const bad = delegatedMergeProblems(g);
  assert.ok(bad.some((b) => /closed/.test(b)) && bad.some((b) => /draft/.test(b)) && bad.some((b) => /not mergeable \(conflicting\)/.test(b)));
});

test("delegatedMergeProblems: ignore_checks excuses only the listed check", () => {
  const g = good();
  g.info.statusCheckRollup.push({ __typename: "CheckRun", name: "Analyze (python)", status: "COMPLETED", conclusion: "FAILURE" });
  assert.deepEqual(delegatedMergeProblems(g), []);
  g.info.statusCheckRollup.push({ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" });
  assert.deepEqual(delegatedMergeProblems(g), ["lint: failure"]);
  g.ignore = [];
  assert.equal(delegatedMergeProblems(g).length, 2);
});

test("delegatedMergeProblems: protected paths are refused", () => {
  const g = { ...good(), files: ["rig.yaml"], protectedPatterns: ["rig.yaml"] };
  assert.match(delegatedMergeProblems(g)[0], /touches protected files \(rig.yaml\)/);
});

// ---------- reaskChurn ----------

test("reaskChurn: two self-closes in the hour block a new ask", () => {
  const t = Date.parse("2026-10-14T00:40:00Z");
  const asks = [
    { id: "a", from: "o", status: "closed", answered: "2026-10-14T00:18:00Z", answer: "folded into the merge ask" },
    { id: "b", from: "o", status: "closed", answered: "2026-10-14T00:27:00Z", answer: "#47 is getting one more change" },
  ];
  assert.deepEqual(reaskChurn(asks, "o", t), ["a", "b"]);
});

test("reaskChurn: closes because Luis acted, old closes and other seats don't count", () => {
  const t = Date.parse("2026-10-14T00:40:00Z");
  const asks = [
    { id: "a", from: "o", status: "closed", answered: "2026-10-14T00:18:00Z", answer: "closed: Luis merged #44" },
    { id: "b", from: "o", status: "closed", answered: "2026-10-13T22:00:00Z", answer: "superseded" },
    { id: "c", from: "x", status: "closed", answered: "2026-10-14T00:30:00Z", answer: "superseded" },
    { id: "d", from: "o", status: "closed", answered: "2026-10-14T00:31:00Z", answer: "superseded" },
    { id: "e", from: "o", status: "answered", answered: "2026-10-14T00:32:00Z", answer: "yes" },
  ];
  assert.deepEqual(reaskChurn(asks, "o", t), []);
});
