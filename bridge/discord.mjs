#!/usr/bin/env node
// Qubicle <-> Discord bridge. Posts the qb feed to Discord and turns your replies
// into qb answers or orchestrator messages. Runs on the Mac via launchd.
//
//   node bridge/discord.mjs          run the bridge
//   node bridge/discord.mjs --dry    print what would be posted from new feed rows (no Discord)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.QUBICLE_HOME || path.join(os.homedir(), ".qubicle");
const FEED = path.join(HOME, "feed.jsonl");
const STATE = path.join(HOME, "discord-state.json");
const QB = path.join(ROOT, "bin", "qb.mjs");
const ORCH = "lead-orchestrator@qubicle";
const DRY = process.argv.includes("--dry");

const cfg = (YAML.parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8")) || {}).discord || {};
const CHANNELS = { digest: "digest", decisions: "decisions", updates: "updates", chat: "orchestrator", ...(cfg.channels || {}) };
const SILENT = 1 << 12; // Discord SUPPRESS_NOTIFICATIONS flag

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const state = readJson(STATE, { offset: null, asks: {}, threads: {} });
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const mode = () => readJson(path.join(HOME, "state.json"), { mode: "active" }).mode;
const qb = (...args) => spawnSync(process.execPath, [QB, ...args], { encoding: "utf8" });
const seat = (s) => (s || "").replace(/@qubicle$/, "");
const clip = (s, n = 1900) => (s.length > n ? s.slice(0, n - 20) + "\n…(truncated)" : s);

// ---------- feed -> messages ----------

// Turn one feed row into { channel, content, ask? } or null to skip.
export function render(row) {
  const who = seat(row.from);
  switch (row.level) {
    case "decision":
      return { channel: "decisions", content: `**${who}** needs a decision\n${row.text}`, ask: { id: row.id, options: row.options || [] } };
    case "digest": {
      let body = row.text;
      if (row.file) { try { body = `**${row.text}**\n${fs.readFileSync(row.file, "utf8").trim()}`; } catch {} }
      return { channel: "digest", content: clip(body) };
    }
    case "chat":
      return { channel: "chat", content: clip(row.text) };
    case "urgent":
      return { channel: "updates", content: `🚨 **${who}**: ${row.text}`, loud: true };
    case "mode":
      return { channel: "updates", content: `Mode: **${row.text.replace(/^Luis is now /, "")}**` };
    case "answer":
      return null; // handled by editing the original decision message
    default:
      return { channel: "updates", content: `**${who}**: ${row.text}` };
  }
}

function newRows() {
  if (!fs.existsSync(FEED)) return [];
  const size = fs.statSync(FEED).size;
  if (state.offset === null || state.offset > size) { state.offset = size; saveState(); return []; } // first run: start at the end
  if (size === state.offset) return [];
  const fd = fs.openSync(FEED, "r");
  const buf = Buffer.alloc(size - state.offset);
  fs.readSync(fd, buf, 0, buf.length, state.offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n") + 1; // only whole lines
  state.offset += Buffer.byteLength(text.slice(0, end));
  return text.slice(0, end).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

if (DRY) {
  state.offset = 0;
  for (const row of newRows()) { const m = render(row); if (m) console.log(`#${CHANNELS[m.channel]}  ${m.content}${m.ask?.options.length ? `  [${m.ask.options.join(" | ")}]` : ""}\n`); }
  process.exit(0);
}

// ---------- discord ----------

const { Client, Events, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, SlashCommandBuilder } = await import("discord.js");

if (!cfg.guild || !cfg.owner) { log("config.yaml needs discord.guild and discord.owner"); process.exit(1); }
const token = (() => {
  try { return execFileSync("security", ["find-generic-password", "-s", "qubicle-discord", "-w"], { encoding: "utf8" }).trim(); }
  catch { log("No Discord token in Keychain (service qubicle-discord). Run scripts/setup.sh."); process.exit(1); }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const channels = {};

async function post(m) {
  const ch = channels[m.channel];
  if (!ch) { log(`missing channel #${CHANNELS[m.channel]}`); return; }
  const away = mode() === "away";
  const ping = away && (m.ask || m.loud) ? `<@${cfg.owner}> ` : "";
  const opts = { content: ping + m.content, allowedMentions: { users: [cfg.owner] } };
  if (!away) opts.flags = SILENT; // at your desk: keep a log, don't buzz the phone
  if (m.ask?.options.length) {
    opts.components = chunk(m.ask.options.slice(0, 25), 5).map((row, r) => new ActionRowBuilder().addComponents(
      row.map((label, i) => new ButtonBuilder().setCustomId(`ans:${m.ask.id}:${r * 5 + i}`).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Secondary))));
  }
  const msg = await ch.send(opts);
  if (m.ask) {
    const thread = await msg.startThread({ name: `reply ${m.ask.id}`, autoArchiveDuration: 1440 }).catch(() => null);
    state.asks[m.ask.id] = { channelId: ch.id, messageId: msg.id, options: m.ask.options };
    if (thread) state.threads[thread.id] = m.ask.id;
    saveState();
  }
}
const chunk = (a, n) => a.reduce((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);

async function markAnswered(id, text) {
  const ref = state.asks[id];
  if (!ref) return;
  try {
    const ch = await client.channels.fetch(ref.channelId);
    const msg = await ch.messages.fetch(ref.messageId);
    await msg.edit({ content: `${msg.content}\n✅ **Answered:** ${text}`, components: [] });
  } catch (e) { log("could not mark answered", id, e.message); }
  delete state.asks[id];
  saveState();
}

function answer(id, text) {
  const r = qb("answer", id, text);
  return (r.stdout || r.stderr || "").trim();
}

async function pump() {
  for (const row of newRows()) {
    try {
      if (row.level === "answer") { await markAnswered(row.id, row.text); continue; }
      const m = render(row);
      if (m) await post(m);
    } catch (e) { log("post failed", e.message); }
  }
  saveState();
}

const isOwner = (u) => u?.id === cfg.owner;

client.on(Events.InteractionCreate, async (ix) => {
  if (!isOwner(ix.user)) return ix.isRepliable() && ix.reply({ content: "Not yours.", flags: MessageFlags.Ephemeral });
  if (ix.isButton() && ix.customId.startsWith("ans:")) {
    const [, id, idx] = ix.customId.split(":");
    const choice = state.asks[id]?.options?.[Number(idx)] ?? `option ${idx}`;
    await ix.deferUpdate();
    answer(id, choice); // the feed's answer row edits the message
    return;
  }
  if (!ix.isChatInputCommand()) return;
  const run = (...a) => { const r = qb(...a); return (r.stdout || r.stderr || "").trim() || "(nothing)"; };
  const reply = (t) => ix.reply({ content: "```\n" + clip(t, 1900) + "\n```" });
  switch (ix.commandName) {
    case "away": return reply(run("mode", "away"));
    case "back": return reply(run("mode", "active"));
    case "status": return reply(run("status"));
    case "inbox": return reply(run("inbox"));
    case "digest": return reply(run("digest", ix.options.getString("kind") || "pulse") || "requested");
  }
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !isOwner(msg.author)) return;
  const askId = state.threads[msg.channelId];
  if (askId) {
    const out = answer(askId, msg.content);
    await msg.react(out.startsWith("sent") ? "✅" : "⚠️").catch(() => {});
    return;
  }
  if (msg.channelId === channels.chat?.id) {
    const r = spawnSync("rig", ["send", ORCH, `[Luis via Discord] ${msg.content}`], { encoding: "utf8" });
    await msg.react(r.status === 0 ? "📨" : "⚠️").catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  const guild = await client.guilds.fetch(cfg.guild);
  const all = await guild.channels.fetch();
  for (const [key, name] of Object.entries(CHANNELS)) {
    channels[key] = all.find((c) => c?.type === ChannelType.GuildText && c.name === name);
    if (!channels[key]) log(`create a text channel named #${name}`);
  }
  await guild.commands.set([
    new SlashCommandBuilder().setName("away").setDescription("Away mode: updates come to your phone"),
    new SlashCommandBuilder().setName("back").setDescription("Active mode: back at the desk"),
    new SlashCommandBuilder().setName("status").setDescription("Mode, open questions, seats"),
    new SlashCommandBuilder().setName("inbox").setDescription("Decisions waiting on you"),
    new SlashCommandBuilder().setName("digest").setDescription("Ask the orchestrator for a digest now")
      .addStringOption((o) => o.setName("kind").setDescription("morning, evening or pulse")
        .addChoices({ name: "morning", value: "morning" }, { name: "evening", value: "evening" }, { name: "pulse", value: "pulse" })),
  ].map((c) => c.toJSON()));
  log(`ready as ${client.user.tag}`);
  setInterval(pump, 2000);
});

client.login(token);
