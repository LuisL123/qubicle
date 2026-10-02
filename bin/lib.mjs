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
