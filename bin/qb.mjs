#!/usr/bin/env node
// qb: Qubicle helper. Mode, asks, notifications, worktrees, merge policy, digests.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "..");
const HOME = process.env.QUBICLE_HOME || path.join(os.homedir(), ".qubicle");
const WORK = path.join(ROOT, "work");
const RIG = "qubicle";
const ORCH = `lead-orchestrator@${RIG}`;
const APPROVED_LABEL = "qb-approved";

const p = (...xs) => path.join(HOME, ...xs);
const mkdirs = () => ["inbox", "digests", "approvals"].forEach((d) => fs.mkdirSync(p(d), { recursive: true }));
const now = () => new Date().toISOString();
// Local time, e.g. "2026-10-02 09:00"
const local = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace("T", " ");
const log = (...a) => console.error(...a);
const die = (msg, code = 1) => { log(`qb: ${msg}`); process.exit(code); };

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function tryRun(cmd, args, opts) {
  try { return run(cmd, args, opts); } catch { return null; }
}
const gh = (args) => run("gh", args);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// Parse "--flag value" and "--flag" options; everything else is positional.
function parseArgs(argv) {
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

// ---------- mode ----------

const getMode = () => readJson(p("state.json"), { mode: "active", since: null }).mode;

function cmdMode([value]) {
  if (!value) { console.log(getMode()); return; }
  if (!["active", "away"].includes(value)) die("mode must be 'active' or 'away'");
  const prev = getMode();
  writeJson(p("state.json"), { mode: value, since: now() });
  console.log(value);
  if (prev !== value) {
    feed({ level: "mode", text: `Luis is now ${value}` });
    rigSend(ORCH, `[qb] Luis is now ${value}.`);
  }
}

// ---------- feed / notify ----------

function feed(entry) {
  mkdirs();
  const row = { ts: now(), mode: getMode(), from: process.env.OPENRIG_SESSION_NAME || "luis", ...entry };
  fs.appendFileSync(p("feed.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

function macNotify(title, text) {
  if (process.platform !== "darwin") return;
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
  spawnSync("osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}" sound name "Glass"`]);
}

function cmdNotify(argv) {
  const { opts, pos } = parseArgs(argv);
  const text = pos.join(" ");
  if (!text) die('usage: qb notify "<text>" [--level info|digest|urgent] [--file <path>]');
  const level = opts.level || "info";
  const file = typeof opts.file === "string" ? path.resolve(opts.file) : undefined;
  feed({ level, text, file });
  // Active: Mac notification. Away: the Discord bridge (phase 2) picks it up from the feed.
  if (getMode() === "active") macNotify(level === "urgent" ? "Qubicle (urgent)" : "Qubicle", text);
}

function cmdFeed(argv) {
  const { opts } = parseArgs(argv);
  const n = Number(opts.n || 20);
  const lines = fs.existsSync(p("feed.jsonl")) ? fs.readFileSync(p("feed.jsonl"), "utf8").trim().split("\n") : [];
  for (const l of lines.slice(-n)) {
    const r = JSON.parse(l);
    console.log(`${local(new Date(r.ts)).slice(5)}  ${r.level.padEnd(8)} ${r.from.padEnd(24)} ${r.text}`);
  }
}

// ---------- ask / answer ----------

function cmdAsk(argv) {
  const { opts, pos } = parseArgs(argv);
  const question = pos.join(" ");
  if (!question) die('usage: qb ask "<question>" [--options "yes|no"]');
  mkdirs();
  const id = Date.now().toString(36).slice(-6);
  const from = opts.from || process.env.OPENRIG_SESSION_NAME || ORCH;
  const options = typeof opts.options === "string" ? opts.options.split("|").map((s) => s.trim()) : [];
  writeJson(p("inbox", `${id}.json`), { id, from, question, options, status: "open", created: now() });
  feed({ level: "decision", id, text: question, options });
  if (getMode() === "active") macNotify("Qubicle needs you", question);
  console.log(id);
}

function openAsks() {
  if (!fs.existsSync(p("inbox"))) return [];
  return fs.readdirSync(p("inbox")).filter((f) => f.endsWith(".json"))
    .map((f) => readJson(p("inbox", f))).filter((a) => a && a.status === "open")
    .sort((a, b) => a.created.localeCompare(b.created));
}

function cmdInbox() {
  const asks = openAsks();
  if (!asks.length) { console.log("Nothing waiting on you."); return; }
  for (const a of asks) {
    const opts = a.options.length ? `  [${a.options.join(" / ")}]` : "";
    console.log(`${a.id}  ${a.from}\n  ${a.question}${opts}`);
  }
}

function cmdAnswer([id, ...rest]) {
  const text = rest.join(" ");
  if (!id || !text) die('usage: qb answer <id> "<reply>"');
  const file = p("inbox", `${id}.json`);
  const ask = readJson(file);
  if (!ask) die(`no ask with id ${id}`);
  Object.assign(ask, { status: "answered", answer: text, answered: now() });
  writeJson(file, ask);
  feed({ level: "answer", id, text });
  const ok = rigSend(ask.from, `[Luis] re ${id} ("${ask.question.slice(0, 80)}"): ${text}`);
  console.log(ok ? `sent to ${ask.from}` : `saved, but ${ask.from} is not running. Answer again once the rig is up.`);
}

function rigSend(session, text) {
  const r = spawnSync("rig", ["send", session, text], { encoding: "utf8" });
  if (r.status !== 0) log(`qb: could not reach ${session} (${(r.stderr || "").trim().split("\n")[0]})`);
  return r.status === 0;
}

// ---------- repos / policy ----------

function loadRepos() {
  const raw = YAML.parse(fs.readFileSync(path.join(ROOT, "repos.yaml"), "utf8")) || {};
  return raw.repos || [];
}

function checkRepo(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) die(`expected owner/repo, got "${repo}"`);
}

function policyOf(repo) {
  checkRepo(repo);
  const entry = loadRepos().find((r) => r.repo?.toLowerCase() === repo.toLowerCase());
  if (!entry) return { policy: "shared", reason: "not listed in repos.yaml" };
  if (entry.policy !== "owned") return { policy: "shared", reason: "listed as shared" };
  const me = gh(["api", "user", "--jq", ".login"]).toLowerCase();
  if (repo.split("/")[0].toLowerCase() !== me) return { policy: "shared", reason: `owner is not ${me}` };
  const out = tryRun("gh", ["api", `repos/${repo}/contributors`, "--paginate", "--jq", ".[].login"]) ?? "";
  const others = out.split("\n").filter(Boolean)
    .filter((l) => !l.endsWith("[bot]") && l.toLowerCase() !== me);
  if (others.length) return { policy: "shared", reason: `other contributors: ${others.slice(0, 5).join(", ")}` };
  return { policy: "owned", reason: "listed as owned, only you have committed" };
}

function cmdPolicy([repo]) {
  const r = policyOf(repo);
  console.log(`${r.policy}  (${r.reason})`);
}

// ---------- worktrees ----------

function cmdWt([repo, branch, ...rest]) {
  checkRepo(repo);
  if (!branch) die("usage: qb wt <owner/repo> <branch> [--base <branch>]");
  const { opts } = parseArgs(rest);
  const slug = repo.replace("/", "__");
  const clone = path.join(WORK, "repos", slug);
  const wt = path.join(WORK, "wt", slug, branch.replace(/[^\w.-]+/g, "-"));
  if (fs.existsSync(wt)) { console.log(wt); return; }

  fs.mkdirSync(path.dirname(clone), { recursive: true });
  if (!fs.existsSync(clone)) {
    log(`qb: cloning ${repo}`);
    run("gh", ["repo", "clone", repo, clone, "--", "--quiet"]);
  }
  const git = (...a) => run("git", ["-C", clone, ...a]);
  git("fetch", "--quiet", "--prune", "origin");
  const base = opts.base || (tryRun("git", ["-C", clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) || "origin/main").replace(/^origin\//, "");

  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const remoteHas = tryRun("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  const localHas = tryRun("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (localHas) git("worktree", "add", "--quiet", wt, branch);
  else if (remoteHas) git("worktree", "add", "--quiet", "--track", "-b", branch, wt, `origin/${branch}`);
  else git("worktree", "add", "--quiet", "--no-track", "-b", branch, wt, `origin/${base}`);
  console.log(wt);
}

// ---------- review / merge ----------

function cmdApprove([repo, pr, ...rest]) {
  checkRepo(repo);
  if (!pr) die('usage: qb approve <owner/repo> <pr> [--note "..."]');
  const { opts } = parseArgs(rest);
  const pol = policyOf(repo);
  writeJson(p("approvals", `${repo.replace("/", "__")}#${pr}.json`), { repo, pr, by: process.env.OPENRIG_SESSION_NAME || "luis", at: now(), note: opts.note || null });
  if (pol.policy === "owned") {
    tryRun("gh", ["label", "create", APPROVED_LABEL, "-R", repo, "--color", "2da44e", "--description", "Reviewed by Qubicle", "--force"]);
    gh(["pr", "edit", pr, "-R", repo, "--add-label", APPROVED_LABEL]);
  }
  // Shared repos: no labels or comments on other people's repos. Approval stays local.
  feed({ level: "info", text: `Approved ${repo}#${pr} (${pol.policy})` });
  console.log(pol.policy === "owned" ? `approved. next: qb merge ${repo} ${pr}` : "approved locally. shared repo: Luis merges.");
}

function checksGreen(rollup) {
  const bad = [];
  for (const c of rollup || []) {
    if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED") bad.push(`${c.name}: ${c.status.toLowerCase()}`);
      else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) bad.push(`${c.name}: ${c.conclusion.toLowerCase()}`);
    } else if (c.state && c.state !== "SUCCESS") bad.push(`${c.context}: ${c.state.toLowerCase()}`);
  }
  return bad;
}

function cmdMerge([repo, pr]) {
  checkRepo(repo);
  if (!pr) die("usage: qb merge <owner/repo> <pr>");
  const pol = policyOf(repo);
  if (pol.policy !== "owned") die(`refusing: ${repo} is shared (${pol.reason}). Ask Luis.`);

  let info;
  for (let i = 0; i < 6; i++) {
    info = JSON.parse(gh(["pr", "view", pr, "-R", repo, "--json", "state,isDraft,mergeable,labels,statusCheckRollup,url"]));
    if (info.mergeable !== "UNKNOWN") break;
    spawnSync("sleep", ["3"]);
  }
  const problems = [];
  if (info.state !== "OPEN") problems.push(`PR is ${info.state.toLowerCase()}`);
  if (info.isDraft) problems.push("PR is a draft");
  if (!info.labels.some((l) => l.name === APPROVED_LABEL)) problems.push(`missing ${APPROVED_LABEL} (run qb approve first)`);
  if (info.mergeable !== "MERGEABLE") problems.push(`not mergeable (${info.mergeable.toLowerCase()})`);
  problems.push(...checksGreen(info.statusCheckRollup));
  if (problems.length) die(`refusing to merge ${repo}#${pr}:\n  - ${problems.join("\n  - ")}`);

  gh(["pr", "merge", pr, "-R", repo, "--squash", "--delete-branch"]);
  feed({ level: "info", text: `Merged ${info.url}` });
  console.log(`merged ${info.url}`);
}

// ---------- digests ----------

function cmdDigest([kind]) {
  if (!["morning", "evening", "pulse"].includes(kind)) die("usage: qb digest morning|evening|pulse");
  if (kind === "pulse" && getMode() !== "away") { log("qb: active, skipping pulse"); return; }
  mkdirs();
  const stamp = local().replace(" ", "T").replace(":", "");
  const out = p("digests", `${stamp}-${kind}.md`);
  const last = fs.readdirSync(p("digests")).filter((f) => f.endsWith(".md")).sort().pop();
  const template = fs.readFileSync(path.join(ROOT, "prompts", `${kind}.md`), "utf8");
  const prompt = template
    .replaceAll("{{NOW}}", new Date().toString())
    .replaceAll("{{MODE}}", getMode())
    .replaceAll("{{LAST}}", last ? p("digests", last) : "none yet")
    .replaceAll("{{OUT}}", out)
    .replaceAll("{{REPOS}}", path.join(ROOT, "repos.yaml"))
    .replaceAll("{{OPEN_ASKS}}", String(openAsks().length));
  const promptFile = p("digests", `.${stamp}-${kind}.prompt.md`);
  fs.writeFileSync(promptFile, prompt);
  const ok = rigSend(ORCH, `[qb digest ${kind}] Read and follow ${promptFile}`);
  if (!ok) macNotify("Qubicle", `Couldn't reach the orchestrator for the ${kind} digest. Is the rig up?`);
}

// ---------- status ----------

function cmdStatus() {
  console.log(`mode:   ${getMode()}`);
  console.log(`asks:   ${openAsks().length} waiting on you (qb inbox)`);
  const ps = spawnSync("rig", ["ps", "--nodes", "--rig", RIG], { encoding: "utf8" });
  console.log("\n" + ((ps.stdout || "").trim() || (ps.stderr || "").trim() || "rig: not reachable. Run scripts/boot.sh"));
}

// ---------- main ----------

const HELP = `qb: Qubicle helper

  qb status                     mode, open asks, seats
  qb mode [active|away]         show or set your mode
  qb inbox                      decisions waiting on you
  qb answer <id> "<reply>"      answer one; the asking seat gets it
  qb feed [--n 20]              recent notifications

  qb ask "<question>" [--options "a|b"]          (agents) ask Luis
  qb notify "<text>" [--level info|digest|urgent] [--file f]
  qb wt <owner/repo> <branch> [--base main]      worktree path for a branch
  qb policy <owner/repo>                         owned or shared
  qb approve <owner/repo> <pr>                   mark reviewed
  qb merge <owner/repo> <pr>                     merge if owned, approved, green
  qb digest morning|evening|pulse                ask the orchestrator for a digest`;

const [cmd, ...args] = process.argv.slice(2);
const table = {
  status: cmdStatus, mode: cmdMode, inbox: cmdInbox, answer: cmdAnswer, feed: cmdFeed,
  ask: cmdAsk, notify: cmdNotify, wt: cmdWt, policy: cmdPolicy, approve: cmdApprove,
  merge: cmdMerge, digest: cmdDigest,
};
if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") console.log(HELP);
else if (!table[cmd]) die(`unknown command "${cmd}". Try qb help.`);
else {
  try { table[cmd](args); }
  catch (e) { die((e.stderr?.toString().trim() || e.message).split("\n").slice(0, 4).join("\n")); }
}
