#!/usr/bin/env node
// qb: Qubicle helper. Mode, asks, notifications, worktrees, merge policy, digests.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseArgs, checksGreen, protectedHits, missedDigest, staleDigests, quietSinceLastDigest, delegatedMergeProblems, reaskChurn, needsFreshLaunch, atInteractivePrompt } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "..");
const HOME = process.env.QUBICLE_HOME || path.join(os.homedir(), ".qubicle");
const WORK = path.join(ROOT, "work");
const RIG = "qubicle";
const ORCH = `lead-orchestrator@${RIG}`;
const REVIEWER = `review-codex@${RIG}`;
const APPROVED_LABEL = "qb-approved";

const p = (...xs) => path.join(HOME, ...xs);
const mkdirs = () => ["inbox", "digests", "approvals"].forEach((d) => fs.mkdirSync(p(d), { recursive: true }));
const now = () => new Date().toISOString();
// Local time, e.g. "2026-10-02 09:00"
const local = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace("T", " ");
// Timestamped when launchd captures it, plain in a terminal.
const log = (...a) => console.error(...(process.stderr.isTTY ? a : [new Date().toISOString(), ...a]));
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
  if (!opts.now && fs.existsSync(p("inbox"))) {
    const all = fs.readdirSync(p("inbox")).filter((f) => f.endsWith(".json")).map((f) => readJson(p("inbox", f)));
    const churn = reaskChurn(all, from, Date.now());
    if (churn.length) die(`not sent: you closed ${churn.join(", ")} in the last hour and are asking again. Every ask pings Luis's phone. Keep one ask open and list newly ready items in your next digest; re-ask when an hour has passed. Use --now only if work is blocked on this.`);
  }
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

function cmdClose([id, ...rest]) {
  const why = rest.join(" ") || "no longer needed";
  if (!id) die('usage: qb close <id> "why"   (retire a stale or superseded ask)');
  const file = p("inbox", `${id}.json`);
  const ask = readJson(file);
  if (!ask) die(`no ask with id ${id}`);
  if (ask.status !== "open") die(`${id} is already ${ask.status}`);
  Object.assign(ask, { status: "closed", answer: why, answered: now() });
  writeJson(file, ask);
  feed({ level: "answer", id, text: `closed: ${why}` });
  if (ask.project) logDecision(ask.project, `${seat(ask.from)} closed its ask: ${ask.question} (${why})`);
  console.log(`${id} closed`);
}

let lastRigSendError = "";
function rigSend(session, text) {
  const r = spawnSync("rig", ["send", session, text], { encoding: "utf8" });
  lastRigSendError = r.status === 0 ? "" : `${r.stderr || ""}${r.stdout || ""}`;
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

// ---------- watchdog ----------
// Plain code, no AI. Runs from qb tick every 5 minutes:
//  - seat's harness exited (tile is a bare shell) or its session vanished -> relaunch
//  - seat stuck on a prompt for 15+ min -> tell Luis
//  - seat idle with open queue items for 30+ min -> nudge it, then tell the orchestrator
//    (and flag a likely provider refusal so the work goes to a different model)
const REFUSAL = /content (filter|polic)|usage polic|safety (check|filter|system)|flagged|can(no|')t (help|assist|comply)|unable to (help|assist)|violat/i;
const MIN = 60e3;

function rigNodes() {
  const r = spawnSync("rig", ["ps", "--nodes", "--rig", RIG, "--json", "--fields",
    "logicalId,canonicalSessionName,runtime,agentActivity,pendingWorkCount,inProgressWorkCount"], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) return null;
  const nodes = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (v.logicalId && v.canonicalSessionName) { nodes.push(v); return; }
    Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(r.stdout)); } catch { return null; }
  return nodes;
}

// Returns { session: alive } or null when tmux can't be read (e.g. launchd's bare
// environment), so the watchdog never acts on missing data. "Alive" means the pane's
// process tree contains the harness. Pane names alone mislead: on this Mac Claude shows
// as its version ("2.1.290") and a healthy Codex seat as "bash" (OpenRig's wrapper),
// while a dead tile is just the login shell with nothing under it.
const HARNESS = /claude|codex|node|^\d+\.\d+\.\d+$/i;
function paneCommands() {
  const env = { ...process.env, LANG: process.env.LANG || "en_US.UTF-8", LC_CTYPE: process.env.LC_CTYPE || "en_US.UTF-8" };
  const r = spawnSync("tmux", ["-u", "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_current_command}"], { encoding: "utf8", env });
  if (r.status !== 0 || !(r.stdout || "").trim()) return null;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  if (ps.status !== 0) return null;
  const kids = {}, comm = {};
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    comm[m[1]] = path.basename(m[3].trim());
    (kids[m[2]] ??= []).push(m[1]);
  }
  const hasHarness = (pid, depth = 0) =>
    HARNESS.test(comm[pid] || "") || (depth < 6 && (kids[pid] || []).some((c) => hasHarness(c, depth + 1)));
  const map = {};
  for (const line of r.stdout.split("\n")) {
    const [sess, pid, cmd] = line.split("\t");
    if (sess) map[sess] = { alive: hasHarness(pid) || HARNESS.test(cmd || ""), cmd };
  }
  return map;
}

function watchdogCfg() {
  try { return (YAML.parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8")) || {}).watchdog || {}; } catch { return {}; }
}

function cmdWatch(argv = []) {
  const { opts } = parseArgs(argv);
  const dry = !!opts.dry;
  const act = (what, fn) => { if (dry) console.log(`would: ${what}`); else { fn(); log(`watchdog: ${what}`); } };
  const st = readJson(p("watch.json"), { seats: {}, daemonDown: false });
  const t = Date.now();

  const nodes = rigNodes();
  if (!nodes) {
    if (!st.daemonDown) act("OpenRig not answering: run boot.sh and tell Luis", () => {
      spawnSync("bash", [path.join(ROOT, "scripts", "boot.sh")], { stdio: "ignore", timeout: 120_000 });
      feed({ from: "watchdog", level: "urgent", text: "Watchdog: OpenRig wasn't answering. I ran boot.sh; check qb status." });
    });
    st.daemonDown = true;
    if (!dry) writeJson(p("watch.json"), st);
    return;
  }
  st.daemonDown = false;
  const panes = paneCommands();
  // Safety: if tmux can't be read, or every seat looks gone at once, that's a
  // detection problem, not five crashes. Don't relaunch anything; say so once.
  const allGone = panes && nodes.length > 1 && nodes.every((n) => panes[n.canonicalSessionName] === undefined);
  if (!panes || allGone) {
    if (!st.blindSpot) act("skip crash checks: can't see tmux sessions", () =>
      feed({ from: "watchdog", level: "urgent", text: `Watchdog can't see the seats' tmux sessions (${panes ? "none matched" : "tmux unreadable"}), so it skipped crash checks. Nothing was relaunched.` }));
    st.blindSpot = true;
  } else st.blindSpot = false;

  for (const n of nodes) {
    const id = n.logicalId, sess = n.canonicalSessionName;
    const s = (st.seats[id] ??= { shellTicks: 0, relaunches: [], inputSince: null, inputNotified: false, idleSince: null, nudges: 0, lastNudge: 0, escalated: false });
    const state = n.agentActivity?.state || "unknown";
    const open = (n.pendingWorkCount || 0) + (n.inProgressWorkCount || 0);
    const pane = panes ? panes[sess] : undefined;

    // 1. crashed harness. Alert-only unless config.yaml sets watchdog.auto_relaunch: true,
    // because a wrong guess here kills a working seat.
    const looksDead = pane === undefined || !pane.alive;
    if (!st.blindSpot && looksDead && !["running", "needs-input"].includes(state)) {
      s.shellTicks += 1;
      if (s.shellTicks >= 2 && !s.crashAlerted) {
        const detail = `tmux shows "${pane ? pane.cmd : "no session"}" with no Claude or Codex process under it, OpenRig says "${state}"`;
        if (watchdogCfg().auto_relaunch) {
          s.relaunches = s.relaunches.filter((x) => t - x < 60 * MIN);
          if (s.relaunches.length < 2) {
            act(`relaunch ${id} (${detail})`, () => {
              spawnSync(process.execPath, [fileURLToPath(import.meta.url), "relaunch", id, ...(pane === undefined ? [] : ["--force"])], { stdio: "ignore", timeout: 120_000 });
              feed({ from: "watchdog", level: "info", text: `Watchdog relaunched ${id} (${detail})` });
            });
            s.relaunches.push(t);
            s.shellTicks = 0;
            continue;
          }
        }
        act(`tell Luis ${id} looks crashed (${detail})`, () => feed({ from: "watchdog", level: "urgent",
          text: `${id} looks crashed (${detail}). If its tile is a bare shell: qb relaunch ${id} --force. If it's fine, tell Claude the watchdog misread it.` }));
        s.crashAlerted = true;
      }
      continue;
    }
    s.crashAlerted = false;
    s.shellTicks = 0;

    // 2. waiting on a prompt
    if (state === "needs-input") {
      s.inputSince ??= t;
      if (!s.inputNotified && t - s.inputSince >= 15 * MIN) {
        act(`tell Luis ${id} is stuck on a prompt`, () => feed({ from: "watchdog", level: "urgent", text: `${id} has been waiting on a prompt (${n.agentActivity?.reason || "unknown"}) for ${Math.round((t - s.inputSince) / MIN)} min. Open its tile to answer.` }));
        s.inputNotified = true;
      }
    } else { s.inputSince = null; s.inputNotified = false; }

    // 3. idle with open work
    if (state === "idle" && open > 0) {
      s.idleSince ??= t;
      const idleMin = (t - s.idleSince) / MIN;
      if (idleMin >= 30 && s.nudges < 2 && t - s.lastNudge >= 30 * MIN) {
        act(`nudge ${id} (${open} open items, idle ${Math.round(idleMin)} min)`, () =>
          rigSend(sess, `[qb watchdog] You have ${open} open queue item(s) but have been idle for ${Math.round(idleMin)} min. Pick it back up, or block/hand it back with a reason (rig queue list --owned).`));
        s.nudges += 1; s.lastNudge = t;
      } else if (s.nudges >= 2 && !s.escalated && t - s.lastNudge >= 30 * MIN) {
        const cap = spawnSync("rig", ["capture", sess, "--lines", "60"], { encoding: "utf8" });
        const refused = REFUSAL.test(cap.stdout || "");
        const hint = refused ? ` Its screen looks like a provider refusal, so reassign the item to a different model (a Claude seat if this is Codex).` : "";
        act(`escalate ${id} to the orchestrator${refused ? " (looks like a refusal)" : ""}`, () =>
          rigSend(ORCH, `[qb watchdog] ${id} has ${open} open item(s), has been idle ${Math.round(idleMin)} min and ignored two nudges.${hint} Unblock or reassign it.`));
        s.escalated = true;
      }
    } else { s.idleSince = null; s.nudges = 0; s.lastNudge = 0; s.escalated = false; }
  }
  if (!dry) writeJson(p("watch.json"), st);
}

// ---------- blind seats ----------
// A blind seat must not see certain files (results, labels, answers) so its work
// stays an honest experiment. Only Claude seats: their permission deny rules
// block the Read/Edit/Grep/Glob tools, and /clear drops what they already read.
// Codex seats have no per-path deny, so they can't be blinded.

const CLAUDE_SEAT_DIRS = { "lead.orchestrator": "orchestrator", "build.claude": "builder-claude", "build.grunt": "grunt" };
const sessionOf = (seatRef) => `${seatRef.replace(".", "-")}@${RIG}`;

function seatSettingsFile(seatRef) {
  const dir = CLAUDE_SEAT_DIRS[seatRef];
  if (!dir) die(`${seatRef}: only Claude seats support this (${Object.keys(CLAUDE_SEAT_DIRS).join(", ")}). Codex has no per-path block while it runs with full access.`);
  return path.join(ROOT, "seats", dir, ".claude", "settings.local.json");
}

function absPath(p) {
  const x = p.trim().replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(x) ? path.normalize(x) : path.resolve(ROOT, x);
}

// Claude Code permission rules: "//abs/path" means an absolute path.
const denyRulesFor = (abs) => ["Read", "Edit"].flatMap((t) => [`${t}(/${abs})`, `${t}(/${abs}/**)`]);

function cmdBlind(argv) {
  const { opts, pos: [sub, seatRef] } = parseArgs(argv);
  const blind = readJson(p("blind.json"), {});
  if (sub === "status" || !sub) {
    const rows = Object.entries(blind);
    if (!rows.length) { console.log("No blind seats."); return; }
    for (const [s, b] of rows) console.log(`${s}  blind since ${local(new Date(b.started))} for ${b.project}\n  hidden: ${b.hide.join(", ")}`);
    return;
  }
  if (!["start", "end"].includes(sub) || !seatRef) die('usage: qb blind start <pod.member> --project p --hide "path1,path2" [--why "..."] | qb blind end <pod.member> | qb blind status');
  const file = seatSettingsFile(seatRef);
  const settings = readJson(file, {});
  settings.permissions ??= {};
  const deny = new Set(settings.permissions.deny || []);

  if (sub === "start") {
    const project = projectOf(opts);
    if (typeof opts.hide !== "string") die("--hide is required: comma-separated paths the seat must not see");
    if (blind[seatRef]) die(`${seatRef} is already blind (qb blind end ${seatRef} first)`);
    const hide = opts.hide.split(",").map(absPath).filter(Boolean);
    const rules = hide.flatMap(denyRulesFor);
    rules.forEach((r) => deny.add(r));
    settings.permissions.deny = [...deny];
    writeJson(file, settings);
    blind[seatRef] = { project, hide, rules, why: opts.why || null, started: now() };
    writeJson(p("blind.json"), blind);
    // Wipe what the seat already read, then tell it the rules.
    spawnSync("rig", ["send", sessionOf(seatRef), "/clear", "--raw"], { encoding: "utf8" });
    spawnSync("sleep", ["3"]);
    rigSend(sessionOf(seatRef), `[qb] You are now BLIND for project ${project}. Do not read, search, or ask anyone about: ${hide.join(", ")}. Reading them would invalidate the experiment. If your task seems to need them, stop and tell the orchestrator. Your context was cleared on purpose; take your next item from the queue.`);
    logDecision(project, `${seat(process.env.OPENRIG_SESSION_NAME || "luis")} made ${seatRef} blind to ${hide.join(", ")}${opts.why ? ` (why: ${opts.why})` : ""}`);
    feed({ level: "info", text: `${seatRef} is now blind for ${project}` });
    console.log(`${seatRef} is blind: context cleared, ${rules.length} deny rules added`);
    return;
  }

  // end
  const b = blind[seatRef];
  if (!b) die(`${seatRef} isn't blind`);
  b.rules.forEach((r) => deny.delete(r));
  settings.permissions.deny = [...deny];
  writeJson(file, settings);
  delete blind[seatRef];
  writeJson(p("blind.json"), blind);
  rigSend(sessionOf(seatRef), `[qb] You are no longer blind for ${b.project}. The hidden paths are readable again.`);
  logDecision(b.project, `${seatRef} is no longer blind`);
  feed({ level: "info", text: `${seatRef} is no longer blind for ${b.project}` });
  console.log(`${seatRef} unblinded`);
}

// ---------- sandbox (Claude seats) ----------
// Turns on Claude Code's own OS-level sandbox (Seatbelt on macOS) for a seat's
// shell commands: writes only to the seat, work dirs and tool caches, no reads of
// secrets, no "retry unsandboxed" escape. Blind deny rules become OS-enforced too.
// Settings apply to the running seat, no restart. Defaults live in config.yaml.

function sandboxBlock() {
  let c = {};
  try { c = (YAML.parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8")) || {}).sandbox || {}; } catch {}
  return {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    excludedCommands: c.excluded_commands || [],
    filesystem: { allowWrite: c.allow_write || [], denyRead: c.deny_read || [] },
  };
}

function cmdSandbox(argv) {
  const { pos: [sub, seatRef] } = parseArgs(argv);
  if (sub === "status" || !sub) {
    for (const [ref] of Object.entries(CLAUDE_SEAT_DIRS)) {
      const on = readJson(seatSettingsFile(ref), {}).sandbox?.enabled === true;
      console.log(`${ref.padEnd(18)} ${on ? "sandboxed" : "off"}`);
    }
    console.log("(Codex seats have no equivalent while they run with full access.)");
    return;
  }
  if (!["on", "off"].includes(sub) || !seatRef) die("usage: qb sandbox on|off <pod.member> | qb sandbox status");
  const file = seatSettingsFile(seatRef);
  const settings = readJson(file, {});
  if (sub === "on") settings.sandbox = sandboxBlock(); else delete settings.sandbox;
  writeJson(file, settings);
  feed({ level: "info", text: `Sandbox ${sub} for ${seatRef}` });
  console.log(`sandbox ${sub} for ${seatRef} (applies to its next shell command)`);
}

// ---------- usage ----------

function cmdUsage(argv) {
  const { opts } = parseArgs(argv);
  const win = typeof opts.window === "string" ? opts.window : "24h";
  const show = (title, cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
    console.log(`## ${title}\n${((r.stdout || "") + (r.status ? r.stderr || "" : "")).trim() || "(nothing)"}\n`);
  };
  show(`Tokens by seat, last ${win}`, "rig", ["usage", "top", "--window", win]);
  show("Provider limit signals", "rig", ["provider", "signals"]);
  const key = tryRun("security", ["find-generic-password", "-s", "qubicle-deepseek", "-w"]);
  if (key) {
    const r = spawnSync("curl", ["-s", "--max-time", "15", "https://api.deepseek.com/user/balance", "-H", `Authorization: Bearer ${key}`], { encoding: "utf8" });
    try {
      const b = JSON.parse(r.stdout).balance_infos?.[0];
      console.log(`## DeepSeek balance\n${b ? `${b.total_balance} ${b.currency}` : "(unknown)"}`);
    } catch { console.log("## DeepSeek balance\n(unavailable)"); }
  }
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
// Digests must not vanish silently: catch up on a missed morning/evening run,
// re-send a prompt the orchestrator dropped, and tell Luis if it still never came.
function checkDigests() {
  const dir = p("digests");
  const files = fs.readdirSync(dir);
  const missed = missedDigest(local(), files);
  if (missed) { log(`digest: catching up on missed ${missed}`); cmdDigest([missed]); return; }
  // The watchdog already told Luis the orchestrator is down; retries would only add noise.
  if (readJson(p("watch.json"), { seats: {} }).seats?.["lead.orchestrator"]?.crashAlerted) return;
  const state = readJson(p("digest-retries.json"), {});
  const prompts = files.filter((f) => f.endsWith(".prompt.md"))
    .map((name) => ({ name, ageMin: (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs) / 60000 }));
  let dirty = false;
  for (const base of staleDigests(prompts, files)) {
    const st = state[base] || {};
    const promptFile = path.join(dir, `.${base}.prompt.md`);
    if (!st.resent) {
      const sent = rigSend(ORCH, `[qb digest retry] This digest never arrived. Read and follow ${promptFile}`);
      st.resent = now(); dirty = true;
      log(sent ? `digest: re-sent ${base}` : `digest: re-send of ${base} refused`);
      if (sent) delete state._promptAlert;
      if (!sent && atInteractivePrompt(lastRigSendError)) {
        // Say what's actually wrong instead of waiting 30 min to say "may be stuck",
        // but once per stuck spell, not once per digest; remind at most daily.
        const last = state._promptAlert ? Date.parse(state._promptAlert) : 0;
        if (Date.now() - last > 24 * 60 * MIN) {
          feed({ from: "watchdog", level: "chat", text: `The orchestrator is waiting at a prompt in its terminal, so digests can't go out. Open it (qb open) and answer the prompt; the digest follows on the next tick.` });
          state._promptAlert = now();
        }
        st.alerted = true;
      }
    } else if (!st.alerted && base.endsWith("pulse") && Date.now() - Date.parse(st.resent) > 30 * 60000) {
      // A dropped pulse is low stakes (the next digest covers it); log it, don't ping.
      log(`digest: ${base} never arrived after a retry (not pinging for a pulse)`);
      st.alerted = true; dirty = true;
    } else if (!st.alerted && Date.now() - Date.parse(st.resent) > 30 * 60000) {
      feed({ from: "watchdog", level: "chat", text: `The ${base.split("-").pop()} digest (${base.slice(0, 15).replace("T", " ")}) never arrived, even after a retry. The orchestrator may be stuck; check it with qb open.` });
      st.alerted = true; dirty = true;
    }
    state[base] = st;
  }
  if (dirty) writeJson(p("digest-retries.json"), state);
}

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
  try { checkDigests(); } catch (e) { log(`digest check error: ${e.message}`); }
  try { cmdWatch(); } catch (e) { log(`watchdog error: ${e.message}`); }
  try { bootHeal(); } catch (e) { log(`boot heal error: ${e.message}`); }
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
  // delegated: the orchestrator merges, after the reviewer's approval of the exact head commit.
  // No owner or contributor check: the repo carries upstream history by design.
  if (entry.policy === "delegated") return { policy: "delegated", reason: "listed as delegated: the orchestrator merges after review-codex approves the head commit" };
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
  // delegated: record the head commit being approved; a later push makes the approval stale. No labels on the shared repo.
  const sha = pol.policy === "delegated" ? gh(["pr", "view", pr, "-R", repo, "--json", "headRefOid", "--jq", ".headRefOid"]) : undefined;
  writeJson(p("approvals", `${repo.replace("/", "__")}#${pr}.json`), { repo, pr, by: process.env.OPENRIG_SESSION_NAME || "luis", at: now(), note: opts.note || null, ...(sha ? { sha } : {}) });
  if (pol.policy === "owned") {
    tryRun("gh", ["label", "create", APPROVED_LABEL, "-R", repo, "--color", "2da44e", "--description", "Reviewed by Qubicle", "--force"]);
    gh(["pr", "edit", pr, "-R", repo, "--add-label", APPROVED_LABEL]);
  }
  // Shared repos: no labels or comments on other people's repos. Approval stays local.
  feed({ level: "info", text: `Approved ${repo}#${pr} (${pol.policy})` });
  console.log(pol.policy === "owned" ? `approved. next: qb merge ${repo} ${pr}`
    : pol.policy === "delegated" ? `approved ${sha.slice(0, 7)} locally. the orchestrator merges with qb merge ${repo} ${pr}; a new push needs a new approval.`
    : "approved locally. shared repo: Luis merges.");
}

function cmdMerge([repo, pr]) {
  checkRepo(repo);
  if (!pr) die("usage: qb merge <owner/repo> <pr>");
  const pol = policyOf(repo);
  if (pol.policy === "delegated") return mergeDelegated(repo, pr);
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

// Delegated repos (repos.yaml `policy: delegated`): only the orchestrator merges, and only a PR whose
// current head commit the reviewer approved. Spec: work/specs/qubicle/delegated-merge.md.
function mergeDelegated(repo, pr) {
  const seatName = process.env.OPENRIG_SESSION_NAME || "";
  if (seatName !== ORCH) die(`refusing to merge ${repo}#${pr}:\n  - only ${ORCH} merges delegated repos (you are ${seatName || "not a seat"})`);
  const entry = loadRepos().find((r) => r.repo?.toLowerCase() === repo.toLowerCase());
  let info;
  for (let i = 0; i < 6; i++) {
    info = JSON.parse(gh(["pr", "view", pr, "-R", repo, "--json", "state,isDraft,mergeable,headRefOid,statusCheckRollup,url"]));
    if (info.mergeable !== "UNKNOWN") break;
    spawnSync("sleep", ["3"]);
  }
  const approval = readJson(p("approvals", `${repo.replace("/", "__")}#${pr}.json`), null);
  const files = JSON.parse(gh(["pr", "view", pr, "-R", repo, "--json", "files"])).files.map((f) => f.path);
  const problems = delegatedMergeProblems({ seat: seatName, orchestrator: ORCH, reviewer: REVIEWER, info, approval, files,
    ignore: entry?.ignore_checks || [], protectedPatterns: entry?.protected || [] });
  if (problems.length) die(`refusing to merge ${repo}#${pr}:\n  - ${problems.join("\n  - ")}`);
  // --match-head-commit: GitHub itself refuses if the head moved since the check above.
  gh(["pr", "merge", pr, "-R", repo, "--squash", "--delete-branch", "--match-head-commit", info.headRefOid]);
  feed({ level: "info", text: `Merged ${info.url} (delegated, approved at ${info.headRefOid.slice(0, 7)})` });
  console.log(`merged ${info.url}`);
}

// ---------- digests ----------

function cmdDigest([kind]) {
  if (!["morning", "evening", "pulse"].includes(kind)) die("usage: qb digest morning|evening|pulse");
  if (kind === "pulse" && getMode() !== "away") { log("qb: active, skipping pulse"); return; }
  if (kind === "pulse") {
    const rows = fs.existsSync(p("feed.jsonl"))
      ? fs.readFileSync(p("feed.jsonl"), "utf8").trim().split("\n").slice(-200).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      : [];
    if (quietSinceLastDigest(rows)) { log("qb: nothing new since the last digest, skipping pulse"); return; }
  }
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
function relaunchSeat(seatRef, force) {
  if (force) {
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
  if (!id) { log(`rig ${RIG} not found in rig ps. Is it up? (qb open)`); return 1; }
  const seat = seatRef.replace("-", ".");
  const launch = (args) => {
    const r = spawnSync("rig", args, { encoding: "utf8" });
    process.stdout.write(`${r.stdout || ""}${r.stderr || ""}`);
    return r;
  };
  let r = launch(["launch", id, seat]);
  // After a reboot OpenRig may have no resume token for a seat and refuse to resume it.
  // A fresh, primed seat beats a dead one (work lives in tickets and the queue, not the session).
  if (r.status !== 0 && needsFreshLaunch(`${r.stdout}${r.stderr}`)) {
    log(`qb: ${seat} can't be resumed, starting it fresh`);
    r = launch(["seat", "launch", `${seat}@${RIG}`, "--fresh", "--reason", "qb relaunch: no resumable session (e.g. after a reboot)"]);
  }
  return r.status ?? 1;
}

function cmdRelaunch(argv) {
  const { opts, pos: [seatRef] } = parseArgs(argv);
  if (!seatRef) die("usage: qb relaunch <pod.member> [--force]   e.g. qb relaunch build.codex --force");
  const status = relaunchSeat(seatRef, !!opts.force);
  if (status !== 0 && !opts.force) log("qb: if it says 'already running' but the tile shows a bare shell, use --force");
  process.exit(status);
}

// Relaunch every seat whose tile has no Claude/Codex process. Used after a
// reboot, when OpenRig keeps the rig "running" but some harnesses never come back.
function cmdHeal() {
  const nodes = rigNodes();
  if (!nodes) { log("qb heal: OpenRig not answering, run scripts/boot.sh first"); return []; }
  const panes = paneCommands();
  if (!panes) { log("qb heal: can't read tmux, not touching anything"); return []; }
  const dead = nodes.filter((n) => !panes[n.canonicalSessionName]?.alive).map((n) => n.logicalId);
  if (!dead.length) { console.log("All seats are running."); return []; }
  const ok = dead.filter((ref) => relaunchSeat(ref, true) === 0);
  const failed = dead.filter((ref) => !ok.includes(ref));
  feed({ from: "watchdog", level: failed.length ? "urgent" : "chat",
    text: `Seats that didn't come back: ${dead.join(", ")}. Relaunched ${ok.length ? ok.join(", ") : "none"}${failed.length ? `; failed: ${failed.join(", ")} (try qb relaunch <seat> --force)` : ""}.` });
  console.log(`relaunched: ${ok.join(", ") || "none"}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  return dead;
}

// Once per boot, a few minutes after boot.sh ran, heal seats that didn't come back.
function bootHeal() {
  const f = p("boot-at");
  if (!fs.existsSync(f)) return;
  const at = Date.parse(fs.readFileSync(f, "utf8").trim());
  const age = Date.now() - at;
  const st = readJson(p("watch.json"), { seats: {} });
  if (!at || age < 3 * 60000 || age > 30 * 60000 || st.healedBoot === at) return;
  st.healedBoot = at;
  writeJson(p("watch.json"), st);
  log("boot heal: checking seats after a restart");
  cmdHeal();
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
  qb blind start <pod.member> --project p --hide "a,b"   clear a Claude seat's context and block paths
  qb blind end <pod.member> | qb blind status
  qb watch [--dry]                               run the watchdog once (it also runs every 5 min)
  qb sandbox on|off <pod.member> | status        OS-level sandbox for a Claude seat's shell commands
  qb usage [--window 24h]                        tokens per seat, provider limits, DeepSeek balance
  qb ask "<question>" [--options "a|b"] [--project p] [--why "..."] [--big] [--now]   (agents) ask Luis
  qb notify "<text>" [--level info|digest|urgent] [--file f]
  qb wt <owner/repo> <branch> [--base main]      worktree path for a branch
  qb policy <owner/repo>                         owned, shared or delegated
  qb approve <owner/repo> <pr>                   mark reviewed
  qb merge <owner/repo> <pr>                     merge if owned (or delegated: orchestrator only), approved, green
  qb digest morning|evening|pulse                ask the orchestrator for a digest
  qb workspaces                                  local (non-GitHub) workspaces
  qb close <id> "why"                            retire a stale or superseded ask
  qb heal                                        relaunch seats with no Claude/Codex running`;

const [cmd, ...args] = process.argv.slice(2);
const table = {
  status: cmdStatus, mode: cmdMode, inbox: cmdInbox, answer: cmdAnswer, close: cmdClose, heal: cmdHeal, feed: cmdFeed,
  ask: cmdAsk, notify: cmdNotify, wt: cmdWt, policy: cmdPolicy, approve: cmdApprove,
  merge: cmdMerge, digest: cmdDigest, open: cmdOpen, relaunch: cmdRelaunch, workspaces: cmdWorkspaces,
  goal: cmdGoal, decide: cmdDecide, propose: cmdPropose, tick: cmdTick, critique: cmdCritique, blind: cmdBlind, watch: cmdWatch, sandbox: cmdSandbox, usage: cmdUsage,
};
if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") console.log(HELP);
else if (!table[cmd]) die(`unknown command "${cmd}". Try qb help.`);
else {
  try { table[cmd](args); }
  catch (e) { die((e.stderr?.toString().trim() || e.message).split("\n").slice(0, 4).join("\n")); }
}
