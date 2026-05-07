// Config loader + validator.
//
// New v0.1 schema (architect-reviewed):
//   {
//     "version": 1,
//     "openclawRoot": "/root/oc",
//     "transcriptDir": "/root/oc/.shared",
//     "openclawBin": "openclaw",
//     "polling": { "intervalMs": 2500, "openclawTimeoutSec": 180 },
//     "apps": [
//       { "appId":"cli_xxx", "appSecret":"${PM_SECRET}", "agent":"pm-host",
//         "role":"产品助理", "botName":"OpenClaw-PM" }
//       // ... one entry per Feishu bot ↔ openclaw agent (1:1 mapping)
//     ],
//     "chats": [
//       { "name":"Case1", "chatId":"oc_xxx", "mode":"round-robin",
//         "host":"pm-host",                     // references apps[].agent
//         "members": ["dev","mkt-a","qa"],
//         "modeOptions": { "maxRounds": 2 } }
//     ]
//   }
//
// Why apps[] and chats[] are separate:
//   1. Same agent could in principle serve multiple chats (rare but possible).
//   2. Secrets live in one place — easier to rotate, easier to scrub diffs.
//   3. chats[] reads as pure topology ("Case1 has pm-host driving dev/mkt-a/qa")
//      without per-chat secret noise.
//
// Secret interpolation: ${VAR} expands to process.env.VAR. We refuse to start
// if a referenced env var is missing, rather than silently passing "${VAR}"
// to the Feishu API and getting an opaque auth error later.

import fs from "node:fs";
import path from "node:path";

export function resolveConfigPath(givenPath) {
  if (givenPath) return path.resolve(givenPath);
  const candidates = [
    "./oc-feishu-link.json",
    "./oc-feishu.config.json",
    path.join(process.env.HOME || "", ".config/oc-feishu-link/config.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error("no config found; pass --config <path> or create ./oc-feishu-link.json");
}

export function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expanded = interpolateEnv(raw, []);
  applyDefaults(expanded);
  validate(expanded);
  return expanded;
}

function interpolateEnv(node, jsonPath) {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v == null || v === "") {
        throw new Error(`config@${jsonPath.join(".")}: env var ${name} referenced but not set`);
      }
      return v;
    });
  }
  if (Array.isArray(node)) return node.map((v, i) => interpolateEnv(v, [...jsonPath, String(i)]));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = interpolateEnv(v, [...jsonPath, k]);
    return out;
  }
  return node;
}

function applyDefaults(c) {
  if (!c.openclawBin) c.openclawBin = "openclaw";
  if (!c.transcriptDir) {
    // Default under openclawRoot if available, else /var/lib/oc-feishu-link/shared.
    c.transcriptDir = c.openclawRoot
      ? path.join(c.openclawRoot, ".shared")
      : "/var/lib/oc-feishu-link/shared";
  }
  if (!c.polling) c.polling = {};
  if (c.polling.intervalMs == null) c.polling.intervalMs = 2500;
  if (c.polling.openclawTimeoutSec == null) c.polling.openclawTimeoutSec = 180;
  for (const chat of c.chats || []) {
    if (!chat.modeOptions) chat.modeOptions = {};
    if (chat.mode === "round-robin" && chat.modeOptions.maxRounds == null) {
      chat.modeOptions.maxRounds = 5;
    }
    if (chat.mode === "free-speak") {
      if (chat.modeOptions.maxMessages == null) chat.modeOptions.maxMessages = 25;
      if (chat.modeOptions.recentSpeakerCooldownMs == null) chat.modeOptions.recentSpeakerCooldownMs = 8000;
    }
    if (chat.modeOptions.endKeyword == null) chat.modeOptions.endKeyword = "[END]";
  }
}

function validate(c) {
  if (!c.openclawRoot) throw new Error("config: openclawRoot is required (path to your openclaw agents root, e.g. /root/oc)");
  if (!Array.isArray(c.apps) || c.apps.length === 0) {
    throw new Error("config.apps must be a non-empty array");
  }
  const agentNames = new Set();
  const appIds = new Set();
  for (const [i, a] of c.apps.entries()) {
    const where = `apps[${i}]`;
    if (!a.appId || !/^cli_/.test(a.appId)) throw new Error(`${where}: appId must start with cli_`);
    if (!a.appSecret) throw new Error(`${where}: appSecret required (consider \${ENV_VAR} interpolation)`);
    if (!a.agent) throw new Error(`${where}: agent (openclaw agent name) required`);
    if (!a.role) throw new Error(`${where}: role (display label) required`);
    if (a.openId && !/^ou_/.test(a.openId)) throw new Error(`${where}: openId, if set, must start with ou_`);
    if (agentNames.has(a.agent)) throw new Error(`${where}: agent name "${a.agent}" duplicated across apps[]`);
    if (appIds.has(a.appId)) throw new Error(`${where}: appId "${a.appId}" duplicated`);
    agentNames.add(a.agent);
    appIds.add(a.appId);
  }
  if (!Array.isArray(c.chats) || c.chats.length === 0) {
    throw new Error("config.chats must be a non-empty array");
  }
  for (const [i, ch] of c.chats.entries()) {
    const where = `chats[${i}] (${ch.name || "unnamed"})`;
    if (!ch.chatId || !/^oc_/.test(ch.chatId)) throw new Error(`${where}: chatId must start with oc_`);
    if (ch.mode !== "round-robin" && ch.mode !== "free-speak") {
      throw new Error(`${where}: mode must be "round-robin" or "free-speak"`);
    }
    if (!ch.host) throw new Error(`${where}: host (agent name) required`);
    if (!agentNames.has(ch.host)) throw new Error(`${where}: host "${ch.host}" not declared in apps[]`);
    if (!Array.isArray(ch.members) || ch.members.length < 1) {
      throw new Error(`${where}: members[] must have ≥ 1 entry`);
    }
    for (const m of ch.members) {
      if (!agentNames.has(m)) throw new Error(`${where}: member "${m}" not declared in apps[]`);
      if (m === ch.host) throw new Error(`${where}: member "${m}" cannot also be the host`);
    }
    if (ch.hostOpenId && !/^ou_/.test(ch.hostOpenId)) {
      throw new Error(`${where}: hostOpenId, if set, must start with ou_`);
    }
  }
}

// Build a denormalized view that the daemon code reads — agents-by-name,
// apps-by-appid, plus per-chat resolved appId/role refs.
export function flatten(config) {
  const byAgent = {};       // agent → app entry
  const byAppId = {};       // appId → app entry
  for (const a of config.apps) {
    byAgent[a.agent] = a;
    byAppId[a.appId] = a;
  }
  const chats = {};
  for (const ch of config.chats) {
    const host = byAgent[ch.host];
    chats[ch.chatId] = {
      ...ch,
      hostApp: host.appId,
      hostAgent: host.agent,
      hostRole: host.role,
      hostBotName: host.botName || host.role,
      memberApps: ch.members.map(m => byAgent[m].appId),
      memberAgents: ch.members.map(m => byAgent[m].agent),
    };
  }
  return { byAgent, byAppId, chats };
}
