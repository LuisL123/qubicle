// qb pure helpers: no I/O, no dependencies. Imported by bin/qb.mjs and the tests.

// Parse "--flag value" and "--flag" options; everything else is positional.
export function parseArgs(argv) {
  const opts = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; } else opts[key] = true;
    } else pos.push(a);
  }
  return { opts, pos };
}

// List of checks that are not green. An empty array means all green.
// `ignore` names checks to skip (repos.yaml ignore_checks, delegated repos only).
export function checksGreen(rollup, ignore = []) {
  const bad = [];
  for (const c of rollup || []) {
    if (ignore.includes(c.name) || ignore.includes(c.context)) continue;
    if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED") bad.push(`${c.name}: ${c.status.toLowerCase()}`);
      else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) bad.push(`${c.name}: ${c.conclusion.toLowerCase()}`);
    } else if (c.state && c.state !== "SUCCESS") bad.push(`${c.context}: ${c.state.toLowerCase()}`);
  }
  return bad;
}

// Files a PR touches that match a protected pattern. "dir/" matches anything under dir.
export function protectedHits(files, patterns) {
  return (files || []).filter((f) => (patterns || []).some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

// Scheduled digests launchd missed (Mac asleep or off at 9:00 / 19:00).
// localStamp is "YYYY-MM-DD HH:MM" local time; files are names in the digests dir.
// Returns the kind to run now, or null. Waits 15 min so a late launchd fire wins.
export const DIGEST_HOURS = { morning: 9, evening: 19 };
export function missedDigest(localStamp, files) {
  const day = localStamp.slice(0, 10);
  const mins = Number(localStamp.slice(11, 13)) * 60 + Number(localStamp.slice(14, 16));
  for (const [kind, h] of Object.entries(DIGEST_HOURS)) {
    if (mins < h * 60 + 15 || mins >= (h + 3) * 60) continue;
    const sent = files.some((f) => f.startsWith(`.${day}T`) && f.endsWith(`-${kind}.prompt.md`));
    if (!sent) return kind;
  }
  return null;
}

// Digest prompts sent to the orchestrator that never produced their output file.
// prompts: [{name, ageMin}] for ".<stamp>-<kind>.prompt.md" files. Returns the names
// (without the leading dot and .prompt.md) older than minAge with no output yet.
export function staleDigests(prompts, files, minAge = 30, maxAge = 360) {
  return prompts
    .filter((x) => x.ageMin >= minAge && x.ageMin <= maxAge)
    .map((x) => x.name.replace(/^\./, "").replace(/\.prompt\.md$/, ""))
    .filter((base) => !files.includes(`${base}.md`));
}

// True when nothing worth a pulse happened since the last digest: only
// digests, mode switches and answers (or nothing) in the feed after it.
const QUIET_LEVELS = new Set(["digest", "mode", "answer"]);
export function quietSinceLastDigest(rows) {
  let i = rows.length - 1;
  while (i >= 0 && rows[i].level !== "digest") i--;
  if (i < 0) return false;
  return rows.slice(i + 1).every((r) => QUIET_LEVELS.has(r.level));
}

// Why a delegated merge must be refused; an empty array means go. Pure: the caller fetches
// `info` (gh pr view: state, isDraft, mergeable, headRefOid, statusCheckRollup), the local
// `approval` record ({by, sha}) and the PR's file list.
export function delegatedMergeProblems({ seat, orchestrator, reviewer, info, approval, files, ignore = [], protectedPatterns = [] }) {
  const bad = [];
  if (seat !== orchestrator) bad.push(`only ${orchestrator} merges delegated repos (you are ${seat || "not a seat"})`);
  if (info.state !== "OPEN") bad.push(`PR is ${String(info.state).toLowerCase()}`);
  if (info.isDraft) bad.push("PR is a draft");
  if (!approval) bad.push("no approval on record (the reviewer runs qb approve first)");
  else {
    if (approval.by !== reviewer) bad.push(`approval is by ${approval.by}, not ${reviewer}`);
    if (!approval.sha) bad.push("approval has no commit SHA (approved before delegated mode, or not a delegated approval); approve again");
    else if (approval.sha !== info.headRefOid) bad.push(`approval is for ${approval.sha.slice(0, 7)} but the PR head is now ${String(info.headRefOid).slice(0, 7)}: a push after approval needs a new approval`);
  }
  if (info.mergeable !== "MERGEABLE") bad.push(`not mergeable (${String(info.mergeable).toLowerCase()})`);
  bad.push(...checksGreen(info.statusCheckRollup, ignore));
  const hits = protectedHits(files, protectedPatterns);
  if (hits.length) bad.push(`touches protected files (${hits.join(", ")}): Luis merges this one`);
  return bad;
}

// Re-ask churn: a seat that closed 2+ of its own asks in the last hour (not
// because Luis acted) and now asks again is pinging Luis's phone to add items.
// Returns the ids of those closes, or [] when the new ask is fine.
export function reaskChurn(asks, from, nowMs, { windowMin = 60, max = 2 } = {}) {
  const since = nowMs - windowMin * 60000;
  const hits = asks.filter((a) => a && a.from === from && a.status === "closed"
    && a.answered && Date.parse(a.answered) >= since && !/\bLuis\b/i.test(a.answer || ""));
  return hits.length >= max ? hits.map((a) => a.id) : [];
}

// OpenRig refuses to resume a seat it has no resume token for and asks for --fresh.
export const needsFreshLaunch = (out) => /unresumable|re-run with --fresh/i.test(out || "");
// rig send refuses when the seat's terminal is sitting at a selection/approval prompt.
export const atInteractivePrompt = (err) => /interactive prompt|selection_prompt/i.test(err || "");
