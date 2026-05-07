#!/usr/bin/env node
// octf CLI. Five commands per architect review §4(a):
//   init    interactive scaffold of config + souls/ for first-time users
//   link    preflight + Feishu auth + group membership + openclaw channels
//   daemon  run / stop / restart / logs / status (foreground or systemd)
//   verify  end-to-end smoke test on one chat (kickoff -> [END])
//   logs    tail daemon log + correlated openclaw runtime log
//
// Global flags: --config <path>, --json (machine-readable output where
// applicable). Default config lookup: ./octf.json then
// ./octf.json then ~/.config/octf/config.json.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigPath, flatten } from "../lib/config.js";
import { runDaemon, preflight, resolveHostOpenIds } from "../lib/daemon.js";
import {
  getTenantToken,
  listChatMessages,
  sendChatMessage,
  listChatMembers,
} from "../lib/feishu.js";
import { render, rosterTable, roleBullets } from "../lib/soul-templater.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── arg parsing ──────────────────────────────────────────────────────────
function parseArgv(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) { out.flags[k] = next; i++; }
      else out.flags[k] = true;
    } else out.positional.push(a);
  }
  return out;
}

function help() {
  console.log(`
octf — wire OpenClaw agents into Feishu groups.

Usage:
  octf <command> [args...] [--config <path>]

Commands:
  init                              Interactive: scaffold config + SOUL templates
  link [--apply]                    Preflight check (auth, channels, membership).
                                    With --apply: also patch resolved open_ids
                                    into souls/<host>.md rosterTable (replacing
                                    init's "ou_REPLACE_BY_LINK_COMMAND" placeholders)
  daemon <start|stop|restart|status|logs>
                                    Run the orchestrator (or pair with systemd)
  verify --chat <oc_xxx> [--topic "..."] [--timeout 600]
                                    End-to-end smoke test
  logs [--chat <oc_xxx>] [--tail]   Correlated daemon + openclaw logs
  help                              This message

Global flags:
  --config <path>                   Path to octf.json
  --json                            Machine-readable output where applicable
`);
}

const args = process.argv.slice(2);
const sub = args.shift();
const { positional, flags } = parseArgv(args);

const configPath = (() => {
  if (flags.config) return path.resolve(flags.config);
  try { return resolveConfigPath(); } catch { return null; }
})();

async function withConfig(fn) {
  if (!configPath) {
    console.error("error: no config found.");
    console.error("  pass --config <path>, or run `octf init` to scaffold one.");
    process.exit(2);
  }
  const cfg = loadConfig(configPath);
  await fn(cfg);
}

// ─── dispatch ─────────────────────────────────────────────────────────────
switch (sub) {
  case "init":           await cmdInit(); break;
  case "link":           await withConfig(cmdLink); break;
  case "daemon":         await cmdDaemon(positional[0] || "start"); break;
  case "verify":         await withConfig(cmdVerify); break;
  case "logs":           await withConfig(cmdLogs); break;
  case "help": case undefined: case "--help": case "-h": help(); break;
  default:
    console.error(`unknown command: ${sub}\n`);
    help();
    process.exit(2);
}

// ─── init: interactive scaffold ───────────────────────────────────────────
async function cmdInit() {
  if (!process.stdin.isTTY) {
    console.error("octf init requires an interactive terminal (TTY).");
    console.error("");
    console.error("If you're trying to scaffold non-interactively, copy the example config instead:");
    console.error("  cp $(npm root -g)/openclaw-team-in-feishu/examples/octf.example.json ./octf.json");
    console.error("  $EDITOR ./octf.json     # fill in cli_xxx / oc_xxx / agent names");
    console.error("Then `octf link` to validate.");
    console.error("");
    console.error("Or drive `init` via a PTY (e.g. `expect`, `script`, or interactive shell).");
    process.exit(2);
  }
  if (fs.existsSync("./octf.json") && !flags.force) {
    console.error("./octf.json already exists. Pass --force to overwrite.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, dflt) => new Promise(res => {
    rl.question(`${q}${dflt ? ` [${dflt}]` : ""}: `, ans => res(ans.trim() || dflt || ""));
  });

  console.log("\noctf init — scaffolding config + SOUL templates.\n");
  const openclawRoot = await ask("openclaw root (where /<agent>/workspace lives)", "/root/oc");
  const transcriptDir = await ask("shared transcript dir", path.join(openclawRoot, ".shared"));
  const numChats = parseInt(await ask("how many groups (chats)", "1"), 10);

  const apps = [];
  const chats = [];
  for (let ci = 0; ci < numChats; ci++) {
    console.log(`\n--- group ${ci + 1} ---`);
    const name = await ask("group name (free label)", `Group${ci + 1}`);
    const chatId = await ask("Feishu chat_id (oc_...)");
    const mode = await ask("mode (round-robin | free-speak)", "round-robin");
    const numMembers = parseInt(await ask("how many members (excluding host)", "3"), 10);

    console.log("\n  host bot:");
    const hostAgent = await ask("    openclaw agent name", "pm-host");
    const hostAppId = await ask("    Feishu app_id (cli_...)");
    const hostBotName = await ask("    Feishu bot display name (e.g. OpenClaw-PM)");
    const hostRole = await ask("    role label (e.g. 产品助理)");
    const hostSecretEnv = await ask("    appSecret env var (will be ${VAR} in config)", `${hostAgent.toUpperCase().replace(/-/g, "_")}_SECRET`);
    apps.push({ appId: hostAppId, appSecret: "${" + hostSecretEnv + "}", agent: hostAgent, role: hostRole, botName: hostBotName });

    const memberAgents = [];
    for (let mi = 0; mi < numMembers; mi++) {
      console.log(`\n  member ${mi + 1}:`);
      const ma = await ask("    openclaw agent name");
      const mid = await ask("    Feishu app_id (cli_...)");
      const mbn = await ask("    Feishu bot display name");
      const mr = await ask("    role label");
      const msEnv = await ask("    appSecret env var", `${ma.toUpperCase().replace(/-/g, "_")}_SECRET`);
      apps.push({ appId: mid, appSecret: "${" + msEnv + "}", agent: ma, role: mr, botName: mbn });
      memberAgents.push(ma);
    }

    const modeOptions = {};
    if (mode === "round-robin") {
      modeOptions.maxRounds = parseInt(await ask("    maxRounds", "5"), 10);
    } else {
      modeOptions.maxMessages = parseInt(await ask("    maxMessages", "25"), 10);
    }
    chats.push({ name, chatId, mode, host: hostAgent, members: memberAgents, modeOptions });
  }
  rl.close();

  const config = {
    version: 1,
    openclawRoot,
    transcriptDir,
    polling: { intervalMs: 2500, openclawTimeoutSec: 180 },
    apps,
    chats,
  };
  fs.writeFileSync("./octf.json", JSON.stringify(config, null, 2) + "\n");
  console.log("\n✓ wrote ./octf.json");

  // Render SOUL.md templates per agent into souls/<agent>.md (NOT directly
  // into openclaw workspace — give the developer a chance to review).
  fs.mkdirSync("./souls", { recursive: true });
  for (const chat of chats) {
    const memberAgents = chat.members.map(m => apps.find(a => a.agent === m));
    const hostApp = apps.find(a => a.agent === chat.host);
    const sharedTranscriptPath = path.join(transcriptDir, `transcript-${chat.chatId}.md`);
    // Host SOUL (placeholder open_ids — `octf link` will fill them
    // after first connecting to Feishu)
    const hostTpl = chat.mode === "free-speak" ? "host-free-speak.md.tpl" : "host-round-robin.md.tpl";
    const placeholderRoster = memberAgents.map(m => ({ role: m.role, openId: "ou_REPLACE_BY_LINK_COMMAND" }));
    const hostVars = {
      host: { role: hostApp.role, style: "（按需填写主持人风格）" },
      sharedTranscriptPath,
      roleBullets: roleBullets(memberAgents.map(m => ({ role: m.role }))),
      rosterTable: rosterTable(placeholderRoster),
      rules: { maxRounds: chat.modeOptions.maxRounds || 5, maxMessages: chat.modeOptions.maxMessages || 25, endKeyword: "[END]" },
    };
    fs.writeFileSync(`./souls/${hostApp.agent}.md`, render(hostTpl, hostVars));
    for (const m of memberAgents) {
      const memberVars = {
        host: { role: hostApp.role },
        member: { role: m.role, style: "（按需填写专业风格）", behaviorClause: "（按需填写发言铁律）" },
        modeLabel: chat.mode === "free-speak" ? "自由发言" : "轮流发言",
        sharedTranscriptPath,
        rules: { endKeyword: "[END]" },
      };
      const tpl = chat.mode === "free-speak" ? "member-free-speak.md.tpl" : "member-round-robin.md.tpl";
      fs.writeFileSync(`./souls/${m.agent}.md`, render(tpl, memberVars));
    }
  }
  console.log("✓ wrote ./souls/<agent>.md (one per agent)");
  console.log("\nNext steps:");
  console.log("  1. Edit ./souls/*.md to fill in business-specific persona + style");
  console.log("  2. Set the appSecret env vars (see config 'appSecret' fields)");
  console.log("  3. Run `octf link` to verify the setup and resolve open_ids");
  console.log("  4. Copy ./souls/*.md into each agent's workspace/SOUL.md (link prints exact paths)");
  console.log("  5. Run `octf daemon start`");
}

// ─── link: preflight checklist ────────────────────────────────────────────
async function cmdLink(cfg) {
  const checklist = [];
  const note = (level, msg) => checklist.push({ level, msg });

  // [1] openclaw preflight
  console.log("\n[1] openclaw channels");
  const pre = preflight(cfg);
  if (pre.ok) {
    note("ok", `openclaw channels: ${pre.hostCount} hosts disabled, ${pre.memberCount} members enabled`);
  } else {
    for (const r of pre.reasons) note("err", r);
  }

  // [2] Feishu auth per app
  console.log("\n[2] Feishu auth");
  for (const a of cfg.apps) {
    try {
      await getTenantToken(a.appId, a.appSecret);
      note("ok", `token for ${a.appId} (${a.role})`);
    } catch (e) {
      note("err", `token for ${a.appId}: ${e.message}`);
    }
  }

  // [3a] If --apply is passed and we can resolve member open_ids from
  // the host's perspective, patch ./souls/<host>.md's rosterTable in-place.
  // This is the missing link between `init` (writes placeholders) and the
  // daemon (which expects real open_ids in the host's SOUL).
  // [3] Group membership + bot open_id resolution.
  //
  // Feishu's chats/{id}/members API only returns USER members, not bots
  // (despite bots being chat members). We use a multi-path resolver that
  // tries members API first, then scans recent message history for
  // @-mentions matching the bot name, then falls back to manual config.
  console.log("\n[3] Group membership + bot open_id resolution");
  const flat = flatten(cfg);
  const { resolveBotOpenId, resolveMemberOpenIdsForHost } = await import("../lib/feishu.js");
  for (const ch of cfg.chats) {
    const fc = flat.chats[ch.chatId];
    const hostApp = cfg.apps.find(a => a.appId === fc.hostApp);
    try {
      const hostRes = await resolveBotOpenId(hostApp.appId, hostApp.appSecret, ch.chatId, fc.hostBotName);
      if (hostRes.openId) {
        note("ok", `${ch.name}: host "${fc.hostBotName}" open_id=${hostRes.openId.slice(0, 14)}… (via ${hostRes.source})`);
      } else if (ch.hostOpenId || hostApp.openId) {
        note("ok", `${ch.name}: host "${fc.hostBotName}" open_id=${(ch.hostOpenId || hostApp.openId).slice(0, 14)}… (from config)`);
      } else {
        note("warn",
          `${ch.name}: cannot resolve host "${fc.hostBotName}" open_id automatically. ` +
          `Daemon will match @-mentions by name (usually fine). ` +
          `To resolve: have anyone @-mention ${fc.hostBotName} in the chat once, OR ` +
          `add chats[].hostOpenId / apps[<host>].openId to config.`);
      }
      // Member open_ids: less critical (round-robin members are reached by
      // host's @-tag using the host's prompt-side roster; free-speak doesn't
      // @ at all). Just check that the bot is configured + token works.
      for (const m of fc.memberAgents) {
        const memberApp = cfg.apps.find(a => a.agent === m);
        const memRes = await resolveBotOpenId(memberApp.appId, memberApp.appSecret, ch.chatId, memberApp.botName);
        if (memRes.openId) {
          note("ok", `${ch.name}: member "${memberApp.role}" (${memberApp.botName}) open_id=${memRes.openId.slice(0, 14)}… (via ${memRes.source})`);
        } else if (memberApp.openId) {
          note("ok", `${ch.name}: member "${memberApp.role}" open_id from config`);
        } else {
          note("warn",
            `${ch.name}: cannot resolve member "${memberApp.role}" open_id (non-blocking — ` +
            `host's SOUL.md roster is what's used at runtime, and the host bot's view of ` +
            `the member's open_id will be auto-injected if the host has ever seen the member speak).`);
        }
      }
    } catch (e) {
      note("err", `${ch.name}: ${e.message}`);
    }
  }

  // [3.5] If round-robin host: try to resolve all member open_ids from
  // host's perspective and (if --apply) patch souls/<host>.md.
  // Free-speak hosts don't @-mention members so they don't need a roster.
  for (const ch of cfg.chats) {
    if (ch.mode !== "round-robin") continue;
    const fc = flat.chats[ch.chatId];
    const hostApp = cfg.apps.find(a => a.appId === fc.hostApp);
    const memberBotNames = ch.members.map(m => cfg.apps.find(a => a.agent === m).botName);
    let memberOpenIds;
    try {
      memberOpenIds = await resolveMemberOpenIdsForHost(hostApp.appId, hostApp.appSecret, ch.chatId, memberBotNames);
    } catch (e) {
      note("warn", `${ch.name}: failed to resolve member open_ids from host perspective: ${e.message}`);
      continue;
    }
    const unresolved = Object.entries(memberOpenIds).filter(([_, v]) => v == null).map(([k, _]) => k);
    if (unresolved.length === 0) {
      note("ok", `${ch.name}: all ${memberBotNames.length} member open_ids resolved from host perspective`);
    } else {
      note("warn",
        `${ch.name}: cannot auto-resolve open_ids for [${unresolved.join(", ")}] from host's perspective. ` +
        `Have the host bot @-mention each one once in this chat to populate the cache, ` +
        `or fill them manually in souls/${hostApp.agent}.md rosterTable.`);
    }
    // Patch souls/<host>.md if it has placeholder rosterTable.
    const soulPath = `./souls/${hostApp.agent}.md`;
    if (flags.apply && fs.existsSync(soulPath)) {
      let soul = fs.readFileSync(soulPath, "utf8");
      let patched = 0;
      for (const m of ch.members) {
        const memberApp = cfg.apps.find(a => a.agent === m);
        const oid = memberOpenIds[memberApp.botName];
        if (!oid) continue;
        const re = new RegExp(`<at user_id="ou_REPLACE_BY_LINK_COMMAND">(${memberApp.role})</at>`, "g");
        const after = soul.replace(re, `<at user_id="${oid}">$1</at>`);
        if (after !== soul) { soul = after; patched++; }
      }
      if (patched > 0) {
        fs.writeFileSync(soulPath, soul);
        note("ok", `${ch.name}: --apply patched ${patched} entries in ${soulPath}`);
      }
    }
  }

  // [4] Agent workspace SOUL.md presence
  console.log("\n[4] Agent workspaces");
  for (const a of cfg.apps) {
    const soul = path.join(cfg.openclawRoot, a.agent, "workspace", "SOUL.md");
    if (fs.existsSync(soul)) {
      const size = fs.statSync(soul).size;
      if (size < 200) note("warn", `${a.agent}: SOUL.md exists but only ${size} bytes — looks empty?`);
      else note("ok", `${a.agent}: SOUL.md present (${size}b)`);
    } else {
      note("err", `${a.agent}: SOUL.md missing at ${soul}`);
    }
  }

  // [5] transcript dir writable
  console.log("\n[5] Transcript dir");
  try {
    fs.mkdirSync(cfg.transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.transcriptDir, ".octf.probe"), String(Date.now()));
    fs.unlinkSync(path.join(cfg.transcriptDir, ".octf.probe"));
    note("ok", `${cfg.transcriptDir} writable`);
  } catch (e) {
    note("err", `${cfg.transcriptDir}: ${e.message}`);
  }

  // Print report
  console.log("\n──── Report ────");
  let pass = 0, warn = 0, fail = 0;
  for (const c of checklist) {
    const sym = c.level === "ok" ? "✓" : c.level === "warn" ? "⚠" : "✗";
    if (c.level === "ok") pass++; else if (c.level === "warn") warn++; else fail++;
    console.log(`  ${sym} ${c.msg}`);
  }
  console.log(`\n  ${pass} pass, ${warn} warn, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFix the ✗ items above before running `octf daemon start`.");
    process.exit(1);
  }
}

// ─── daemon start/stop/etc ────────────────────────────────────────────────
async function cmdDaemon(action) {
  switch (action) {
    case "start": {
      await withConfig(async (cfg) => {
        const flat = await resolveHostOpenIds(cfg);
        for (const ch of cfg.chats) {
          ch._resolvedHostOpenId = flat.chats[ch.chatId].hostOpenId;
        }
        // Inject hostOpenId into the daemon's flat view by mutating cfg.chats
        // entries. Daemon's flatten() picks it up.
        for (const ch of cfg.chats) {
          if (ch._resolvedHostOpenId) {
            ch.host = ch.host; // unchanged
            // Stash open_id on the chat; daemon flatten copies it onto fc.hostOpenId
            ch.hostOpenId = ch._resolvedHostOpenId;
          }
        }
        runDaemon(cfg);
        process.stdin.resume();
      });
      break;
    }
    case "status": {
      // Best-effort systemd status; falls back to "no systemd unit found".
      try {
        const out = execFileSync("systemctl", ["is-active", "octf"],
          { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
        console.log(`octf.service: ${out}`);
      } catch {
        console.log("no octf.service registered with systemd. (Did you set up the unit file? See README.)");
      }
      break;
    }
    case "stop": case "restart": {
      try {
        execFileSync("systemctl", [action, "octf"], { stdio: "inherit" });
      } catch (e) {
        console.error(`systemctl ${action} octf failed. Are you running with systemd?`);
        process.exit(1);
      }
      break;
    }
    case "logs": {
      // Convenience tail of the systemd journal for the unit.
      try {
        execFileSync("journalctl", ["-u", "octf", "-f", "--no-pager"], { stdio: "inherit" });
      } catch (e) {
        console.error("journalctl -u octf failed.");
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`unknown daemon action: ${action}`);
      console.error("usage: octf daemon <start|stop|restart|status|logs>");
      process.exit(2);
  }
}

// ─── verify: end-to-end smoke test ───────────────────────────────────────
async function cmdVerify(cfg) {
  const chatId = flags.chat;
  if (!chatId) {
    console.error("usage: octf verify --chat <oc_xxx> [--topic \"...\"] [--timeout 600]");
    process.exit(2);
  }
  const chat = cfg.chats.find(c => c.chatId === chatId);
  if (!chat) { console.error(`chat ${chatId} not in config`); process.exit(2); }

  // Use first member's app to send the trigger (since we likely don't have
  // a real-user token; member bots can post @-host messages too).
  const triggerApp = cfg.apps.find(a => a.agent === chat.members[0]);
  const hostApp = cfg.apps.find(a => a.agent === chat.host);
  const flat = flatten(cfg);
  const fc = flat.chats[chatId];

  // Resolve host open_id with the same multi-path resolver as `link` /
  // daemon — tries members API, then message history, then config override.
  const { resolveBotOpenId } = await import("../lib/feishu.js");
  let hostOpenId = chat.hostOpenId || hostApp.openId;
  if (!hostOpenId) {
    const r = await resolveBotOpenId(triggerApp.appId, triggerApp.appSecret, chatId, fc.hostBotName);
    hostOpenId = r.openId;
  }
  if (!hostOpenId) {
    console.error(`✗ cannot resolve open_id for host bot "${fc.hostBotName}" in chat ${chatId}.`);
    console.error(`  This blocks verify because we need to construct a valid <at user_id="ou_xxx"> tag.`);
    console.error(`  Fix (any one):`);
    console.error(`    - Run \`octf link\` first; it will print exact resolution status.`);
    console.error(`    - Have any user/bot @-mention "${fc.hostBotName}" in the chat once,`);
    console.error(`      then re-run verify (history-based resolver picks it up).`);
    console.error(`    - Add to config: chats[].hostOpenId="ou_xxx" or apps[<host>].openId="ou_xxx"`);
    console.error(`      (the bot's open_id from its OWN app's perspective).`);
    process.exit(1);
  }

  const tok0 = await getTenantToken(triggerApp.appId, triggerApp.appSecret);
  const topic = flags.topic || "插件 verify 烟测：请按你的 SOUL.md 跑一次完整讨论。";
  const text = `<at user_id="${hostOpenId}">${fc.hostBotName}</at> ${topic}`;
  const sendResp = await sendChatMessage(tok0, chatId, text);
  if (sendResp.code !== 0) { console.error(`trigger failed: ${sendResp.code} ${sendResp.msg}`); process.exit(1); }
  const triggerMid = sendResp.data.message_id;
  console.log(`✓ triggered: msg=${triggerMid}`);

  const timeoutSec = parseInt(flags.timeout || "600", 10);
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  const endKw = chat.modeOptions?.endKeyword || "[END]";
  let lastSeen = 0;
  let threadId = null;
  console.log(`watching chat (then thread) for "${endKw}" from host (timeout ${timeoutSec}s)...`);

  // Phase 1: poll main chat until we find the host's thread root reply.
  // Phase 2: poll the thread itself (where [END] actually lands — main chat
  // does NOT receive sub-thread replies).
  const { listThreadMessages } = await import("../lib/feishu.js");
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 8000));
    try {
      let items;
      if (threadId) {
        const tr = await listThreadMessages(tok0, threadId, { pageSize: 50, sort: "ByCreateTimeAsc" });
        if (tr.code !== 0) continue;
        items = tr.data?.items || [];
      } else {
        const lr = await listChatMessages(tok0, chatId, {
          startTime: Math.floor(start / 1000) - 5, pageSize: 50, sort: "ByCreateTimeAsc",
        });
        if (lr.code !== 0) continue;
        items = lr.data?.items || [];
        // Look for the host's first message (thread root) and pivot to thread polling.
        const hostRoot = items.find(m => m.sender?.id === fc.hostApp && m.thread_id);
        if (hostRoot) {
          threadId = hostRoot.thread_id;
          console.log(`  [${Math.round((Date.now() - start) / 1000)}s] thread opened: ${threadId.slice(-8)} — switching to thread poll`);
          continue;
        }
      }
      if (items.length !== lastSeen) {
        const where = threadId ? "thread" : "chat";
        console.log(`  [${Math.round((Date.now() - start) / 1000)}s] ${where}.msgs=${items.length}`);
        lastSeen = items.length;
      }
      const ended = items.some(m => {
        if (m.sender?.id !== fc.hostApp) return false;
        try { return (JSON.parse(m.body.content).text || "").includes(endKw); } catch { return false; }
      });
      if (ended) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`✓ END detected after ${elapsed}s (thread ${threadId?.slice(-8) || "?"}, ${lastSeen} msgs)`);
        process.exit(0);
      }
    } catch (e) {
      console.error(`  poll: ${e.message}`);
    }
  }
  console.error(`✗ timeout — no [END] within ${timeoutSec}s (thread=${threadId?.slice(-8) || "no thread opened"}, ${lastSeen} msgs)`);
  process.exit(1);
}

// ─── logs: correlated tail ────────────────────────────────────────────────
async function cmdLogs(cfg) {
  // We default to a sane location; users can override via env var.
  const daemonLog = process.env.OCFL_DAEMON_LOG || "/var/log/octf.log";
  const openclawLogDir = process.env.OCFL_OPENCLAW_LOG_DIR || "/tmp/openclaw";
  const today = new Date().toISOString().slice(0, 10);
  const openclawLog = path.join(openclawLogDir, `openclaw-${today}.log`);

  const tail = flags.tail || true;
  console.log(`tailing ${daemonLog} + ${openclawLog} (interleaved)`);
  if (!fs.existsSync(daemonLog)) console.warn(`  (warn) ${daemonLog} not found`);
  if (!fs.existsSync(openclawLog)) console.warn(`  (warn) ${openclawLog} not found`);

  const args2 = ["-F", daemonLog];
  if (fs.existsSync(openclawLog)) args2.push(openclawLog);
  const child = spawn("tail", args2, { stdio: "inherit" });
  child.on("exit", code => process.exit(code || 0));
}
