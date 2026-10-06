#!/usr/bin/env node
// qb: Qubicle helper. Mode, asks, notifications, worktrees, merge policy, digests.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseArgs, checksGreen, protectedHits } from "./lib.mjs";

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
  const project = typeof opts.project === "string" ? opts.project : null;
  const why = typeof opts.why === "string" ? opts.why : null;
  const c = opts.big && project ? critique(project, question, why, from) : null;
  writeJson(p("inbox", `${id}.json`), { id, kind: "ask", from, question, options, project, why, critique: c, status: "open", created: now() });
  feed({ level: "decision", id, text: question, options, why, from, critique: c?.text });
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
  if (ask.status !== "open") die(`${id} is already ${ask.status}`);
  let msg;
  if (ask.kind === "proposal") {
    const approved = /^(go ahead|yes|ok|okay|approve|approved|do it|sure)\b/i.test(text.trim());
    Object.assign(ask, { status: approved ? "approved" : "objected", answer: text, answered: now() });
    msg = approved
      ? `[Luis] re ${id}: go ahead with your proposal ("${ask.question.slice(0, 80)}").`
      : `[Luis] re ${id}: OBJECTION. Do not go ahead with "${ask.question.slice(0, 80)}". Luis says: ${text}`;
    logDecision(ask.project, `${seat(ask.from)} proposed: ${ask.question} → Luis ${approved ? "approved" : `objected: ${text}`}`);
  } else {
    Object.assign(ask, { status: "answered", answer: text, answered: now() });
    msg = `[Luis] re ${id} ("${ask.question.slice(0, 80)}"): ${text}`;
    if (ask.project) logDecision(ask.project, `${seat(ask.from)} asked: ${ask.question} → Luis: ${text}`);
  }
  writeJson(file, ask);
  feed({ level: "answer", id, text });
  const ok = rigSend(ask.from, msg);
  console.log(ok ? `sent to ${ask.from}` : `saved, but ${ask.from} is not running. Answer again once the rig is up.`);
}

function rigSend(session, text) {
  const r = spawnSync("rig", ["send", session, text], { encoding: "utf8" });
  if (r.status !== 0) log(`qb: could not reach ${session} (${(r.stderr || "").trim().split("\n")[0]})`);
  return r.status === 0;
}

// ---------- projects: goals, decisions, proposals ----------
// Each project lives in work/specs/<project>/ with GOAL.md (Luis's intent) and
// DECISIONS.md (one line per decision, newest last).

const seat = (s) => String(s || "").replace(/@qubicle$/, "");
const projDir = (name) => path.join(WORK, "specs", name);

function projectOf(opts, required = true) {
  const name = typeof opts.project === "string" ? opts.project : process.env.QB_PROJECT;
  if (!name) { if (required) die("--project <name> is required (a folder under work/specs/)"); return null; }
  if (!/^[\w.-]+$/.test(name)) die(`bad project name "${name}"`);
  return name;
}

function logDecision(project, line) {
  const dir = projDir(project || "_general");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "DECISIONS.md");
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# Decisions: ${project || "general"}\n\nOne line each, newest last. Luis audits this instead of approving live.\n\n`);
  fs.appendFileSync(f, `- ${local()} · ${line.replace(/\s*\n\s*/g, " ")}\n`);
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(String(s || "").trim());
  if (!m) return null;
  return Number(m[1]) * { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()];
}

const goalFile = (project) => path.join(projDir(project), "GOAL.md");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function cmdGoal(argv) {
  const { opts, pos: [project] } = parseArgs(argv);
  if (!project) die("usage: qb goal <project> [--init | --lock | --unlock]");
  const f = goalFile(project);
  if (opts.unlock) {
    const locks = readJson(p("goals.json"), {});
    delete locks[project];
    writeJson(p("goals.json"), locks);
    if (fs.existsSync(f)) fs.chmodSync(f, 0o644);
    console.log(`unlocked ${f}. Edit it, then qb goal ${project} --lock`);
    return;
  }
  if (opts.init) {
    if (fs.existsSync(f)) die(`${f} already exists`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, fs.readFileSync(path.join(ROOT, "templates", "GOAL.md"), "utf8").replaceAll("{{PROJECT}}", project));
    console.log(f);
    return;
  }
  if (!fs.existsSync(f)) die(`no goal yet for ${project}. Run /grill-me with the orchestrator, then qb goal ${project} --lock`);
  if (opts.lock) {
    const locks = readJson(p("goals.json"), {});
    locks[project] = { file: f, sha: sha(f), locked: now(), alerted: false };
    writeJson(p("goals.json"), locks);
    fs.chmodSync(f, 0o444);
    feed({ level: "info", text: `Goal locked for ${project}` });
    console.log(`locked ${f}`);
    return;
  }
  process.stdout.write(fs.readFileSync(f, "utf8"));
}

function cmdDecide(argv) {
  const { opts, pos } = parseArgs(argv);
  const text = pos.join(" ");
  if (!text) die('usage: qb decide "<decision>" --project <p> --why "<reason>"');
  const project = projectOf(opts);
  const who = seat(process.env.OPENRIG_SESSION_NAME || "luis");
  logDecision(project, `${who} decided: ${text}${opts.why ? ` (why: ${opts.why})` : ""}`);
  feed({ level: "decided", text: `${text}${opts.why ? ` (why: ${opts.why})` : ""}`, project });
  console.log("logged");
}

// ---------- second opinion ----------
// A fresh model with no stake in the plan judges it against GOAL.md. Used for
// big moves (--big on propose/ask) and on demand (qb critique).

function secondOpinionCfg() {
  try {
    const c = YAML.parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8")) || {};
    return { runtime: "codex", model: "", ...(c.second_opinion || {}) };
  } catch { return { runtime: "codex", model: "" }; }
}

function critique(project, plan, why, from) {
  const cfg = secondOpinionCfg();
  if (cfg.runtime === "off") return null;
  const dir = projDir(project);
  const prompt = `You are the second opinion for Qubicle, Luis's team of coding agents. Another agent
(${seat(from)}) wants to make a big move. You have no stake in its plan. Judge it only
against what Luis wants. Read first (read only, change nothing): ${dir}/GOAL.md and the
last 30 lines of ${dir}/DECISIONS.md, plus any file the plan names.

The plan:
${plan}
Their reason: ${why || "(none given)"}

Be skeptical but fair. Reply in at most 150 words, plain words, no em dashes, exactly:
**Verdict:** support, concerns, or oppose
**Strongest case against:** ...
**Goal check:** does it break the budget, a stop rule, an out-of-bounds item, or the priority order?
**What would change my mind:** ...`;
  const out = path.join(os.tmpdir(), `qb-critique-${process.pid}-${Date.now()}.txt`);
  const [cmd, args] = cfg.runtime === "claude"
    ? ["claude", ["-p", prompt, ...(cfg.model ? ["--model", cfg.model] : []), "--permission-mode", "plan"]]
    : ["codex", ["exec", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", ROOT, "-o", out, ...(cfg.model ? ["-m", cfg.model] : []), prompt]];
  log(`qb: getting a second opinion (${cfg.runtime})...`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 8 << 20 });
  let text = "";
  try { text = fs.readFileSync(out, "utf8").trim(); fs.unlinkSync(out); } catch { text = (r.stdout || "").trim(); }
  if (!text) return { verdict: "unavailable", text: "Second opinion unavailable (the model call failed)." };
  const m = /verdict:\**\s*(support|concerns|oppose)/i.exec(text);
  return { verdict: m ? m[1].toLowerCase() : "concerns", text };
}

function cmdCritique(argv) {
  const { opts, pos } = parseArgs(argv);
  const project = projectOf(opts);
  const plan = typeof opts.file === "string" ? fs.readFileSync(opts.file, "utf8") : pos.join(" ");
  if (!plan) die('usage: qb critique "<plan>" --project <p> [--why "..."] [--file plan.md]');
  const c = critique(project, plan, opts.why, process.env.OPENRIG_SESSION_NAME || "luis");
  console.log(c ? c.text : "second opinion is off (config.yaml)");
}

function cmdPropose(argv) {
  const { opts, pos } = parseArgs(argv);
  const text = pos.join(" ");
  if (!text) die('usage: qb propose "<plan>" --project <p> --why "<reason>" [--in 3h]');
  const project = projectOf(opts);
  const ms = parseDuration(opts.in || "3h");
  if (!ms) die(`bad --in "${opts.in}" (use 90m, 3h, 1d)`);
  mkdirs();
  const id = Date.now().toString(36).slice(-6);
  const from = process.env.OPENRIG_SESSION_NAME || ORCH;
  const deadline = new Date(Date.now() + ms).toISOString();
  const why = typeof opts.why === "string" ? opts.why : null;
  const c = opts.big ? critique(project, text, why, from) : null;
  if (c?.verdict === "oppose") {
    // An opposed big move never goes ahead by silence: it becomes a plain ask.
    writeJson(p("inbox", `${id}.json`), { id, kind: "ask", from, question: text, options: ["Go ahead", "Don't"], project, why, critique: c, status: "open", created: now() });
    feed({ level: "decision", id, text, why, options: ["Go ahead", "Don't"], from, project, critique: c.text });
    if (getMode() === "active") macNotify("Qubicle needs you", text);
    console.log(`${id}: the second opinion OPPOSED this, so it waits for Luis instead of going ahead.\n\n${c.text}`);
    return;
  }
  writeJson(p("inbox", `${id}.json`), { id, kind: "proposal", from, question: text, options: ["Go ahead", "Object"], project, why, deadline, critique: c, status: "open", created: now() });
  feed({ level: "decision", kind: "proposal", id, text, why, deadline, options: ["Go ahead", "Object"], from, project, critique: c?.text });
  if (getMode() === "active") macNotify("Qubicle: going ahead unless you object", text);
  console.log(`${id} (goes ahead at ${local(new Date(deadline))} unless Luis objects)${c ? `\n\nSecond opinion:\n${c.text}` : ""}`);
}

// Run every few minutes by launchd: approve proposals nobody objected to, and
// flag a locked GOAL.md that changed.
function cmdTick() {
  mkdirs();
  for (const a of openAsks()) {
    if (a.kind !== "proposal" || Date.now() < Date.parse(a.deadline)) continue;
    Object.assign(a, { status: "approved", answer: "no objection (deadline passed)", answered: now() });
    writeJson(p("inbox", `${a.id}.json`), a);
    logDecision(a.project, `${seat(a.from)} proposed: ${a.question} → approved by silence`);
    feed({ level: "answer", id: a.id, text: "No objection by the deadline, going ahead" });
    rigSend(a.from, `[qb] re ${a.id}: no objection by the deadline. Go ahead with "${a.question.slice(0, 80)}".`);
  }
  const locks = readJson(p("goals.json"), {});
  let dirty = false;
  for (const [project, l] of Object.entries(locks)) {
    const changed = !fs.existsSync(l.file) || sha(l.file) !== l.sha;
    if (changed && !l.alerted) {
      feed({ level: "urgent", text: `GOAL.md for ${project} changed or vanished after you locked it. Check it, then qb goal ${project} --lock again.` });
      l.alerted = true; dirty = true;
    }
  }
  if (dirty) writeJson(p("goals.json"), locks);
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
  const patterns = loadRepos().find((r) => r.repo?.toLowerCase() === repo.toLowerCase())?.protected || [];
  if (patterns.length) {
    const files = JSON.parse(gh(["pr", "view", pr, "-R", repo, "--json", "files"])).files.map((f) => f.path);
    const hits = protectedHits(files, patterns);
    if (hits.length) problems.push(`touches protected files (${hits.join(", ")}): Luis merges this one`);
  }
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

// Relaunch one seat, e.g. after its harness crashed. Seat = pod.member (build.codex).
// --force: the harness crashed but its tmux session (a bare shell) is still up, so
// OpenRig thinks the seat is running. Kill that session first, then relaunch.
function cmdRelaunch(argv) {
  const { opts, pos: [seatRef] } = parseArgs(argv);
  if (!seatRef) die("usage: qb relaunch <pod.member> [--force]   e.g. qb relaunch build.codex --force");
  if (opts.force) {
    const session = `${seatRef.replace(".", "-")}@${RIG}`;
    const k = spawnSync("tmux", ["kill-session", "-t", `=${session}`], { encoding: "utf8" });
    log(k.status === 0 ? `qb: killed tmux session ${session}` : `qb: no tmux session ${session} (continuing)`);
    spawnSync("sleep", ["5"]); // let the daemon notice the session is gone
  }
  const out = run("rig", ["ps", "--fields", "rigId,name", "--json"]);
  let id = null;
  const walk = (v) => {
    if (id || !v || typeof v !== "object") return;
    if ((v.name === RIG || v.rigName === RIG) && v.rigId) { id = v.rigId; return; }
    Object.values(v).forEach(walk);
  };
  walk(JSON.parse(out));
  if (!id) die(`rig ${RIG} not found in rig ps. Is it up? (qb open)`);
  const r = spawnSync("rig", ["launch", id, seatRef.replace("-", ".")], { stdio: "inherit" });
  if (r.status === 0 || opts.force) process.exit(r.status ?? 1);
  log("qb: if it says 'already running' but the tile shows a bare shell, use --force");
  process.exit(r.status ?? 1);
}

function cmdOpen() {
  // Make sure the daemon and rig are up (no-op if they already are), then show the tiles.
  spawnSync("bash", [path.join(ROOT, "scripts", "boot.sh")], { stdio: "inherit" });
  const r = spawnSync("rig", ["terminal", "open", RIG], { stdio: "inherit" });
  if (r.status !== 0) log("qb: no tiles? Start herdr first (run `herdr`), then run qb open inside it.");
}

// Local workspaces: folders the team works in that aren't GitHub repos.
function cmdWorkspaces() {
  const raw = YAML.parse(fs.readFileSync(path.join(ROOT, "repos.yaml"), "utf8")) || {};
  for (const w of raw.workspaces || []) console.log(`${w.name}\t${w.path.replace(/^~/, os.homedir())}`);
}

function cmdStatus() {
  console.log(`mode:   ${getMode()}`);
  console.log(`asks:   ${openAsks().length} waiting on you (qb inbox)`);
  const ps = spawnSync("rig", ["ps", "--nodes", "--rig", RIG], { encoding: "utf8" });
  console.log("\n" + ((ps.stdout || "").trim() || (ps.stderr || "").trim() || "rig: not reachable. Run scripts/boot.sh"));
}

// ---------- main ----------

const HELP = `qb: Qubicle helper

  qb open                       start the team if needed, show it in herdr
  qb relaunch <pod.member> [--force]   restart one seat (--force if its tile is a bare shell)
  qb status                     mode, open asks, seats
  qb mode [active|away]         show or set your mode
  qb inbox                      decisions waiting on you
  qb answer <id> "<reply>"      answer one; the asking seat gets it
  qb feed [--n 20]              recent notifications

  qb goal <project> [--init|--lock|--unlock]     show, start, lock or unlock a project's GOAL.md
  qb decide "<decision>" --project p --why "..."  (agents) decide and log, no ping
  qb propose "<plan>" --project p --why "..." [--in 3h] [--big]   go ahead unless Luis objects
                                                 --big: second opinion first; if it opposes, Luis must answer
  qb critique "<plan>" --project p [--file f]     get a second opinion against GOAL.md, no ping
  qb ask "<question>" [--options "a|b"] [--project p] [--why "..."] [--big]   (agents) ask Luis
  qb notify "<text>" [--level info|digest|urgent] [--file f]
  qb wt <owner/repo> <branch> [--base main]      worktree path for a branch
  qb policy <owner/repo>                         owned or shared
  qb approve <owner/repo> <pr>                   mark reviewed
  qb merge <owner/repo> <pr>                     merge if owned, approved, green
  qb digest morning|evening|pulse                ask the orchestrator for a digest
  qb workspaces                                  local (non-GitHub) workspaces`;

const [cmd, ...args] = process.argv.slice(2);
const table = {
  status: cmdStatus, mode: cmdMode, inbox: cmdInbox, answer: cmdAnswer, feed: cmdFeed,
  ask: cmdAsk, notify: cmdNotify, wt: cmdWt, policy: cmdPolicy, approve: cmdApprove,
  merge: cmdMerge, digest: cmdDigest, open: cmdOpen, relaunch: cmdRelaunch, workspaces: cmdWorkspaces,
  goal: cmdGoal, decide: cmdDecide, propose: cmdPropose, tick: cmdTick, critique: cmdCritique,
};
if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") console.log(HELP);
else if (!table[cmd]) die(`unknown command "${cmd}". Try qb help.`);
else {
  try { table[cmd](args); }
  catch (e) { die((e.stderr?.toString().trim() || e.message).split("\n").slice(0, 4).join("\n")); }
}
