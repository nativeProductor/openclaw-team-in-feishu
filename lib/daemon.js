// Orchestrator daemon. Polls each Feishu group's main chat for @-host
// triggers, drives host openclaw agents to open threads, then per-thread
// either (a) re-invokes host between member @-replies (round-robin) or
// (b) polls each agent with a [SKIP] option after each new message
// (free-speak).
//
// Discussion rules — turn order, max rounds, [END], [SKIP] semantics —
// live in each agent's SOUL.md, not here. The daemon's job is mechanism:
// poll, write transcript, fork openclaw, post replies. Architect-reviewed
// version — see README "Architecture" for design rationale.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  getTenantToken,
  listChatMessages,
  listThreadMessages,
  getMessage,
  replyInThread,
  extractText,
  resolveHostOpenId,
} from "./feishu.js";
import { flatten } from "./config.js";

const SKIP_TOKEN = "[SKIP]";

// Hard preflight: openclaw config must have host bots disabled and member
// bots enabled-and-running. Architect review §3 risk #1 — this is THE
// single biggest deadlock source. Refuse to start instead of corrupting
// a discussion later.
export function preflight(config, openclawBin) {
  let probeOut;
  try {
    probeOut = execFileSync(openclawBin || config.openclawBin || "openclaw",
      ["channels", "status", "--probe"],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }).toString();
  } catch (e) {
    return { ok: false, reasons: [`cannot run \`${openclawBin || "openclaw"} channels status --probe\`: ` +
      (e.stderr ? e.stderr.toString().slice(0, 300) : e.message)] };
  }
  const lines = probeOut.split("\n");
  const reasons = [];
  const flat = flatten(config);
  const hostApps = new Set(Object.values(flat.chats).map(c => c.hostApp));
  const memberApps = new Set();
  for (const c of Object.values(flat.chats)) for (const a of c.memberApps) memberApps.add(a);

  for (const appId of hostApps) {
    const line = lines.find(l => l.includes(appId));
    if (!line) { reasons.push(`host ${appId}: not present in 'openclaw channels status' output`); continue; }
    if (!/disabled/.test(line)) {
      reasons.push(`host ${appId}: must be DISABLED in openclaw config (daemon drives it)\n  fix: openclaw config set channels.feishu.accounts.bot-${appId}.enabled false`);
    }
  }
  for (const appId of memberApps) {
    const line = lines.find(l => l.includes(appId));
    if (!line) { reasons.push(`member ${appId}: not present in 'openclaw channels status' output`); continue; }
    if (!/enabled.*running.*works/.test(line)) {
      reasons.push(`member ${appId}: must be enabled+running+works (currently: ${line.trim()})\n  fix: openclaw config unset channels.feishu.accounts.bot-${appId}.enabled`);
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, hostCount: hostApps.size, memberCount: memberApps.size };
}

export function runDaemon(config, { onLog = console.log, onError = console.error } = {}) {
  fs.mkdirSync(config.transcriptDir, { recursive: true });

  // Preflight gate — refuse to start if openclaw not in expected state.
  const pre = preflight(config);
  if (!pre.ok) {
    onError("[preflight] FAILED — openclaw channel state does not satisfy daemon contract:");
    for (const r of pre.reasons) onError("  ✗ " + r);
    onError("\nDaemon refusing to start. Fix the violations above and retry.");
    process.exit(1);
  }
  onLog(`[preflight] ✓ openclaw channels: ${pre.hostCount} hosts disabled, ${pre.memberCount} members enabled`);

  const flat = flatten(config);
  const groups = flat.chats;
  const apps = flat.byAppId;
  const transcriptDir = config.transcriptDir;
  const pollIntervalMs = config.polling.intervalMs;
  const invokeTimeoutSec = config.polling.openclawTimeoutSec;
  const openclawBin = config.openclawBin || "openclaw";

  const state = {};
  for (const cid of Object.keys(groups)) {
    state[cid] = {
      mainLastTime: Math.floor(Date.now() / 1000) - 30,
      mainProcessedIds: new Set(),
      threads: {},
      kickoffsInFlight: new Set(),
    };
  }
  const threadToChatId = {};

  const tByThread = (tid) => path.join(transcriptDir, `transcript-${tid}.md`);
  const tByChat = (cid) => path.join(transcriptDir, `transcript-${cid}.md`);

  const senderRole = (sender) => {
    if (!sender || !sender.id) return "未知发送者";
    if (sender.id_type === "app_id") return apps[sender.id]?.role || `Bot(${sender.id.slice(-8)})`;
    return `用户(${sender.id.slice(0, 12)}…)`;
  };

  function appendTranscript(chatId, tid, role, text) {
    const ts = new Date().toISOString().slice(11, 19);
    const block = `\n## [${ts}] ${role}\n${text}\n`;
    fs.appendFileSync(tByThread(tid), block);
    if (chatId) fs.appendFileSync(tByChat(chatId), block);
    onLog(`[transcript +] tid=${tid.slice(-8)} | ${role}: ${text.slice(0, 60)}`);
  }

  function ensureThread(chatId, tid) {
    if (!state[chatId].threads[tid]) {
      state[chatId].threads[tid] = {
        processedIds: new Set(),
        active: false, ended: false, invoking: false,
        lastMessageId: null,
        lastSpeakerAppId: null,
        lastSpeakerAt: 0,
        messageCount: 0,
      };
      threadToChatId[tid] = chatId;
      onLog(`[thread NEW] chat=${chatId.slice(-6)} tid=${tid} mode=${groups[chatId].mode}`);
    }
    return state[chatId].threads[tid];
  }

  function runOpenclaw(agentId, prompt) {
    let out;
    try {
      out = execFileSync(openclawBin,
        ["agent", "--agent", agentId, "--message", prompt, "--json", "--timeout", String(invokeTimeoutSec)],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }
      ).toString();
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().slice(0, 600) : "(no stderr)";
      throw new Error(`openclaw agent ${agentId} exit ${e.status}: ${stderr}`);
    }
    const j = JSON.parse(out);
    return j?.result?.payloads?.[0]?.text || j?.data?.reply || j?.data?.text || j?.reply || "";
  }

  async function postReplyAs(appId, replyToMessageId, text) {
    const app = apps[appId];
    const token = await getTenantToken(app.appId, app.appSecret);
    const j = await replyInThread(token, replyToMessageId, text);
    if (j.code !== 0) {
      onError(`[post] err ${j.code} (by=${appId.slice(-8)}): ${j.msg}`);
      return null;
    }
    const newTid = j.data?.thread_id || null;
    onLog(`[post ✓ tid=${newTid?.slice(-8) || "?"} by=${appId.slice(-8)}] ${text.slice(0, 60)}`);
    return { messageId: j.data?.message_id, threadId: newTid };
  }

  // ─── kickoff ──────────────────────────────────────────────────────────
  async function kickoffFromMain(chatId, userMsg) {
    const cfg = groups[chatId];
    const st = state[chatId];
    if (st.kickoffsInFlight.has(userMsg.message_id)) return;
    st.kickoffsInFlight.add(userMsg.message_id);
    try {
      const userText = extractText(userMsg.body.content, userMsg.msg_type);
      const isFree = cfg.mode === "free-speak";
      const prompt = isFree
        ? `# 触发\n用户在主群 @ 了你（主持人）。原始消息：\n\n> ${userText}\n\n` +
          `# 你的任务（自由发言模式）\n` +
          `1. 一句话总结/确认话题；用户没指定就先问。\n` +
          `2. 宣布本群为**自由发言**，鼓励团队随时插话。\n` +
          `3. **不要 @ 任何成员**——daemon 会代你向每个成员询问是否插话。\n` +
          `直接给开场文本（会被发到群里），不要包含 ${cfg.modeOptions.endKeyword}。`
        : `# 触发\n用户在主群 @ 了你（主持人）。原始消息：\n\n> ${userText}\n\n` +
          `# 你的任务（轮流发言模式）\n基于你的 SOUL.md，作为主持人开场：\n` +
          `1. 一句话总结/确认讨论话题（用户没指定就先问）。\n` +
          `2. 宣布发言顺序与目标。\n` +
          `3. 把发言权交给团队第一位成员。**@-tag 必须带明确的发言请求**，` +
          `格式：\`<at user_id="ou_xxx">角色名</at>，请从 [该角色专业视角] 先评估这个需求\`。\n` +
          `   ⚠️ @-tag 不能裸出现——必须前后都有正文，否则被 @ 的 agent 收到空消息会无法回复。\n` +
          `直接给开场文本，不要 meta 解释，不要包含 ${cfg.modeOptions.endKeyword}。`;
      onLog(`[kickoff] ${cfg.hostAgent} replying to msg=${userMsg.message_id.slice(-8)}`);
      const reply = runOpenclaw(cfg.hostAgent, prompt);
      if (!reply) { onError("[kickoff] empty reply"); return; }
      const posted = await postReplyAs(cfg.hostApp, userMsg.message_id, reply);
      if (!posted) return;
      if (posted.threadId) {
        const tst = ensureThread(chatId, posted.threadId);
        tst.active = true;
        tst.lastMessageId = posted.messageId;
      }
    } catch (e) {
      onError(`[kickoff] ${e.message}`);
    } finally {
      st.kickoffsInFlight.delete(userMsg.message_id);
    }
  }

  // ─── round-robin: re-invoke host between member turns ─────────────────
  async function invokeHostRoundRobin(chatId, tid) {
    const cfg = groups[chatId];
    const tst = state[chatId].threads[tid];
    if (tst.invoking) return;
    tst.invoking = true;
    try {
      const transcript = fs.existsSync(tByThread(tid)) ? fs.readFileSync(tByThread(tid), "utf8") : "(空)";
      const endKw = cfg.modeOptions.endKeyword;
      const maxR = cfg.modeOptions.maxRounds;
      const prompt =
        `# 当前讨论的完整 transcript（按时间顺序）\n\n${transcript}\n\n` +
        `# 你的任务\n基于上面 transcript 和你的 SOUL.md，决定本次主持发言：\n` +
        `- 顺序还没轮完且未到第 ${maxR} 轮 → 输出包含三个部分的文本：\n` +
        `    (1) 一句话回应/总结上一位的发言（≤30 字）\n` +
        `    (2) \`<at user_id="ou_xxx">角色名</at>\`（用 SOUL.md 名册里的真实 open_id）\n` +
        `    (3) 紧跟一句**明确的发言请求**，告诉对方从其专业视角补充什么（≥10 字）\n` +
        `  ⚠️ @-tag 不能裸出现——必须前后都有正文，否则被 @ 的 agent 收到空消息会无法回复。\n` +
        `- 信息已充分或第 ${maxR} 轮结束 → 输出最终结论 + ${endKw}（此时禁止 @ 任何人）\n` +
        `直接给主持人发言文本，不要 meta 解释。`;
      onLog(`[invoke RR] ${cfg.hostAgent} tid=${tid.slice(-8)} (${transcript.length}b)`);
      const reply = runOpenclaw(cfg.hostAgent, prompt);
      if (!reply) { onError("[invoke RR] empty"); return; }
      await postReplyAs(cfg.hostApp, tst.lastMessageId, reply);
      if (reply.includes(endKw)) {
        tst.ended = true; tst.active = false;
        onLog(`[session tid=${tid.slice(-8)}] ENDED (round-robin)`);
      }
    } catch (e) {
      onError(`[invoke RR] ${e.message}`);
    } finally {
      tst.invoking = false;
    }
  }

  // ─── free-speak: poll each agent with [SKIP] option ───────────────────
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function tryFreeSpeakStep(chatId, tid) {
    const cfg = groups[chatId];
    const tst = state[chatId].threads[tid];
    if (tst.invoking || tst.ended) return;
    tst.invoking = true;
    try {
      const transcript = fs.existsSync(tByThread(tid)) ? fs.readFileSync(tByThread(tid), "utf8") : "(空)";
      const endKw = cfg.modeOptions.endKeyword;
      const maxMsgs = cfg.modeOptions.maxMessages;

      const lastApp = tst.lastSpeakerAppId;
      const cooldown = cfg.modeOptions.recentSpeakerCooldownMs ?? 8000;
      const tooSoon = lastApp && Date.now() - tst.lastSpeakerAt < cooldown;
      let candidates = shuffle(cfg.memberApps.filter(a => !(tooSoon && a === lastApp)));
      candidates.push(cfg.hostApp); // host as tail fallback (steerer / [END])

      for (const [idx, appId] of candidates.entries()) {
        const isHost = appId === cfg.hostApp;
        const role = apps[appId].role;
        const queueAfter = candidates.slice(idx + 1)
          .map(a => apps[a].role + (a === cfg.hostApp ? "（主持人）" : ""))
          .join(" → ") || "（无，本轮你是最后一位被询问的）";

        const collabState =
          `# 协作状态（daemon 注入，非 SOUL 内容）\n` +
          `- daemon **严格串行**：同一时刻只有一个 agent 在 compose，等其回复或 ${SKIP_TOKEN} 才问下一位。\n` +
          `- 因此**你 compose 期间，没有其他 agent 在写**。你看到的 transcript 是 ground truth。\n` +
          `- **你之后的询问队列**（本轮）：${queueAfter}\n` +
          `- 当前 thread 已累计 ${tst.messageCount} 条成员/主持发言（上限 ${maxMsgs}）。\n` +
          `- 决策提示：如果你犹豫，可以放心 ${SKIP_TOKEN}——队列里后面的 agent 会被问到。\n`;

        const prompt =
          `# 当前讨论的完整 transcript（按时间顺序）\n\n${transcript}\n\n${collabState}\n` +
          `# 你的任务\n你是「${role}」。` +
          (isHost
            ? `本群是**自由发言**模式，你是主持人。基于 transcript：\n` +
              `- 如果讨论已收敛或达到上限，输出最终结论 + ${endKw}\n` +
              `- 如果讨论严重跑题/卡住需要你 steer，输出 steer 文本（不要 @ 任何人）\n` +
              `- 如果讨论正常推进、你不需要插手，**仅输出** ${SKIP_TOKEN}\n`
            : `本群是**自由发言**模式。基于 transcript 和上面的协作状态，自己判断现在是否该插话：\n` +
              `- 仅当涉及你的专业域（看 SOUL.md）、且能给出新视角（不复述）时发言\n` +
              `- 否则**仅输出** ${SKIP_TOKEN}\n` +
              `- 发言不要 @ 任何人；不要复读他人；保持简短\n`) +
          `\n直接给纯文本输出，不要 meta 解释。`;

        onLog(`[invoke FS] ${apps[appId].agent} tid=${tid.slice(-8)} (${transcript.length}b)`);
        let reply;
        try { reply = runOpenclaw(apps[appId].agent, prompt); }
        catch (e) { onError(`[invoke FS ${apps[appId].agent}] ${e.message}`); continue; }

        if (!reply || reply.trim().length < 2) { onLog(`[FS skip empty] ${apps[appId].agent}`); continue; }
        if (reply.trim() === SKIP_TOKEN || reply.trim().startsWith(SKIP_TOKEN)) {
          onLog(`[FS skip] ${apps[appId].agent}`);
          continue;
        }

        const posted = await postReplyAs(appId, tst.lastMessageId, reply);
        if (!posted) continue;
        tst.lastSpeakerAppId = appId;
        tst.lastSpeakerAt = Date.now();
        tst.messageCount++;
        if (isHost && reply.includes(endKw)) {
          tst.ended = true; tst.active = false;
          onLog(`[session tid=${tid.slice(-8)}] ENDED (free-speak host)`);
        }
        return;
      }
      // all candidates skipped — silent loop iteration; next poll tries again
    } finally {
      tst.invoking = false;
    }
  }

  // ─── pollers ──────────────────────────────────────────────────────────
  async function pollMain(chatId) {
    const cfg = groups[chatId];
    const st = state[chatId];
    let token;
    try { token = await getTenantToken(apps[cfg.hostApp].appId, apps[cfg.hostApp].appSecret); }
    catch (e) { onError(`[main token ${chatId.slice(-6)}] ${e.message}`); return; }
    let resp;
    try { resp = await listChatMessages(token, chatId, { startTime: st.mainLastTime, pageSize: 30 }); }
    catch (e) { onError(`[main poll ${chatId.slice(-6)}] ${e.message}`); return; }
    if (resp.code !== 0) { onError(`[main poll ${chatId.slice(-6)}] err ${resp.code}: ${resp.msg}`); return; }

    const items = resp.data?.items || [];
    for (const msg of items) {
      if (st.mainProcessedIds.has(msg.message_id)) continue;
      st.mainProcessedIds.add(msg.message_id);
      const ct = Math.floor(parseInt(msg.create_time) / 1000);
      if (ct > st.mainLastTime) st.mainLastTime = ct;

      const role = senderRole(msg.sender);
      const text = extractText(msg.body.content, msg.msg_type);
      const tid = msg.thread_id;

      if (tid) {
        const tst = ensureThread(chatId, tid);
        if (!tst.processedIds.has(msg.message_id)) {
          tst.processedIds.add(msg.message_id);
          tst.lastMessageId = msg.message_id;
          appendTranscript(chatId, tid, role, text);
          if (msg.sender?.id_type === "app_id") {
            tst.lastSpeakerAppId = msg.sender.id;
            tst.lastSpeakerAt = Date.now();
          }
          if (msg.sender?.id_type === "app_id" && msg.sender?.id === cfg.hostApp) {
            if (text.includes(cfg.modeOptions.endKeyword)) { tst.ended = true; tst.active = false; }
            else { tst.active = true; }
          }
        }
      } else {
        const isUser = msg.sender?.sender_type === "user" || msg.sender?.id_type === "open_id";
        const isNonHostBot = msg.sender?.id_type === "app_id" && msg.sender?.id !== cfg.hostApp;
        if (isUser || isNonHostBot) {
          const mentions = msg.mentions || [];
          const matched = mentions.some(m => m.id === cfg.hostOpenId || m.name === cfg.hostBotName);
          if (matched) {
            onLog(`[user @host main ${chatId.slice(-6)}] msg=${msg.message_id.slice(-8)} from=` +
              (msg.sender?.id_type === "app_id" ? "bot:" + msg.sender.id.slice(-8) : "user"));
            kickoffFromMain(chatId, msg);
          }
        }
      }
    }
  }

  async function pollThread(chatId, tid) {
    const cfg = groups[chatId];
    const tst = state[chatId].threads[tid];
    if (!tst || tst.ended) return;
    const probeApp = cfg.memberApps[0];
    let token;
    try { token = await getTenantToken(apps[probeApp].appId, apps[probeApp].appSecret); }
    catch (e) { onError(`[thread token] ${e.message}`); return; }
    let resp;
    try { resp = await listThreadMessages(token, tid, { pageSize: 50 }); }
    catch (e) { onError(`[thread poll] ${e.message}`); return; }
    if (resp.code !== 0) { onError(`[thread poll tid=${tid.slice(-8)}] err ${resp.code}: ${resp.msg}`); return; }

    const items = resp.data?.items || [];
    for (const msg of items) {
      if (tst.processedIds.has(msg.message_id)) continue;
      tst.processedIds.add(msg.message_id);
      tst.lastMessageId = msg.message_id;

      let sender = msg.sender;
      if (!sender || !sender.id) {
        try {
          const j = await getMessage(token, msg.message_id);
          if (j.code === 0) sender = j.data?.items?.[0]?.sender || sender;
        } catch {}
      }
      const role = senderRole(sender);
      const text = extractText(msg.body.content, msg.msg_type);
      appendTranscript(chatId, tid, role, text);

      if (sender?.id_type === "app_id") {
        tst.lastSpeakerAppId = sender.id;
        tst.lastSpeakerAt = Date.now();
      }

      if (sender?.id_type === "app_id" && sender?.id === cfg.hostApp) {
        if (text.includes(cfg.modeOptions.endKeyword)) {
          tst.ended = true; tst.active = false;
          onLog(`[session tid=${tid.slice(-8)}] [END] from host`);
        } else { tst.active = true; }
        continue;
      }
      if (sender?.id_type === "app_id" && cfg.memberApps.includes(sender.id)) {
        const pos = msg.thread_message_position;
        const isThreadRootParent = pos === undefined || pos === null || String(pos) === "-1";
        if (isThreadRootParent) continue;
        tst.messageCount++;
        if (cfg.mode === "round-robin" && tst.active) {
          onLog(`[trigger RR] tid=${tid.slice(-8)} | ${apps[sender.id]?.role} -> invoke host`);
          invokeHostRoundRobin(chatId, tid);
        }
        continue;
      }
    }

    if (cfg.mode === "free-speak" && tst.active && !tst.ended) {
      await tryFreeSpeakStep(chatId, tid);
    }
  }

  // ─── per-chat async loops ─────────────────────────────────────────────
  // Each chat gets its own self-rescheduling loop. They progress
  // independently — one stuck LLM invocation in chat A doesn't freeze
  // chat B. Inside one chat we still serialize across its threads (cheap,
  // typically <= 2 active threads per chat).
  let stopped = false;
  async function chatLoop(cid) {
    while (!stopped) {
      const t0 = Date.now();
      try { await pollMain(cid); }
      catch (e) { onError(`[main ${cid.slice(-6)}] ${e.message}`); }
      for (const tid of Object.keys(state[cid].threads)) {
        try { await pollThread(cid, tid); }
        catch (e) { onError(`[thr ${tid.slice(-8)}] ${e.message}`); }
      }
      const elapsed = Date.now() - t0;
      const sleep = Math.max(250, pollIntervalMs - elapsed);
      await new Promise(res => setTimeout(res, sleep));
    }
  }

  onLog("[oc-feishu-link daemon] started");
  for (const cid of Object.keys(groups)) {
    chatLoop(cid).catch(e => onError(`[chatLoop ${cid.slice(-6)} fatal] ${e.message}`));
  }

  return {
    stop() { stopped = true; },
    state,
  };
}

// Resolve host bots' open_ids in this chat (host bots have different open_ids
// per app perspective). Called once at daemon start to populate `hostOpenId`
// on each chat config — kickoff matching uses it.
export async function resolveHostOpenIds(config) {
  const flat = flatten(config);
  for (const cid of Object.keys(flat.chats)) {
    const c = flat.chats[cid];
    const open = await resolveHostOpenId(
      c.hostApp, config.apps.find(a => a.appId === c.hostApp).appSecret,
      cid, c.hostBotName
    );
    c.hostOpenId = open;
  }
  return flat;
}
