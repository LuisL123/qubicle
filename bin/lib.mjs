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
export function checksGreen(rollup) {
  const bad = [];
  for (const c of rollup || []) {
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
