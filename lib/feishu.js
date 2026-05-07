// Minimal Feishu open API helpers: token cache + JSON requests.
// Uses native fetch (Node 18+).

const FEISHU_HOST = process.env.OCFL_FEISHU_HOST || "https://open.feishu.cn";

const tokenCache = new Map();

export async function getTenantToken(appId, appSecret) {
  const cached = tokenCache.get(appId);
  if (cached && cached.expireAt > Date.now()) return cached.token;
  const r = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token: code=${j.code} msg=${j.msg}`);
  tokenCache.set(appId, { token: j.tenant_access_token, expireAt: Date.now() + (j.expire - 60) * 1000 });
  return j.tenant_access_token;
}

export async function feishuGet(token, path, params = null) {
  const qs = params ? "?" + new URLSearchParams(params) : "";
  const r = await fetch(`${FEISHU_HOST}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.json();
}

export async function feishuPost(token, path, body) {
  const r = await fetch(`${FEISHU_HOST}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function listChatMessages(token, chatId, { startTime, pageSize = 30, sort = "ByCreateTimeAsc" } = {}) {
  const params = { container_id_type: "chat", container_id: chatId, page_size: String(pageSize), sort_type: sort };
  if (startTime != null) params.start_time = String(startTime);
  return feishuGet(token, "/open-apis/im/v1/messages", params);
}

export async function listThreadMessages(token, threadId, { pageSize = 50, sort = "ByCreateTimeAsc" } = {}) {
  return feishuGet(token, "/open-apis/im/v1/messages", {
    container_id_type: "thread",
    container_id: threadId,
    page_size: String(pageSize),
    sort_type: sort,
  });
}

export async function getMessage(token, messageId) {
  return feishuGet(token, `/open-apis/im/v1/messages/${messageId}`);
}

export async function replyInThread(token, replyToMessageId, text) {
  return feishuPost(token, `/open-apis/im/v1/messages/${replyToMessageId}/reply`, {
    msg_type: "text",
    content: JSON.stringify({ text }),
    reply_in_thread: true,
  });
}

export async function sendChatMessage(token, chatId, text) {
  return feishuPost(token, "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  });
}

export async function listChatMembers(token, chatId, { pageSize = 50 } = {}) {
  return feishuGet(token, `/open-apis/im/v1/chats/${chatId}/members`, {
    member_id_type: "open_id",
    page_size: String(pageSize),
  });
}

// Resolve a bot's open_id from a target app's perspective in a given chat.
// Feishu issues per-app open_ids; the daemon's pollMain compares incoming
// @-mentions' open_ids against this value (it ALSO matches by display name
// as a fallback, so a missing open_id is non-fatal — see pollMain).
//
// IMPORTANT: Feishu's `chats/{chat_id}/members` API only returns USER members,
// not bots — even though bots ARE chat members and the chat info reports them
// in `bot_count`. So we can't simply look up bots by name in the members list.
// We try three paths in order:
//   (1) members API — only succeeds if `botName` is a USER named like the bot
//       (rare, but handles edge cases)
//   (2) recent message history — scan for any past message whose `mentions[]`
//       contains an entry matching `botName`. Works as long as the bot has
//       been @-mentioned in the chat at least once. open_id is then the
//       `mentions[].id` field. This is the path that works in practice.
//   (3) caller-provided override (config: `apps[i].openId` or
//       `chats[i].hostOpenId`) — last-resort manual fallback.
//
// Returns the open_id on success, or null on failure (so callers can decide
// whether null is fatal). Doesn't throw.
export async function resolveBotOpenId(appId, appSecret, chatId, botName) {
  const token = await getTenantToken(appId, appSecret);

  // Path 1: members API
  try {
    const r = await listChatMembers(token, chatId, { pageSize: 100 });
    if (r.code === 0) {
      const items = r.data?.items || [];
      const exact = items.find(it => it.name === botName);
      if (exact) return { openId: exact.member_id, source: "members" };
      const fuzzy = items.find(it => (it.name || "").includes(botName));
      if (fuzzy) return { openId: fuzzy.member_id, source: "members-fuzzy" };
    }
  } catch {}

  // Path 2: scan recent messages for @-mentions of this bot.
  try {
    const lr = await listChatMessages(token, chatId, { pageSize: 50, sort: "ByCreateTimeDesc" });
    if (lr.code === 0) {
      for (const m of lr.data?.items || []) {
        for (const mention of (m.mentions || [])) {
          if (mention.name === botName || (mention.name || "").includes(botName)) {
            return { openId: mention.id, source: "history-mention" };
          }
        }
      }
    }
  } catch {}

  // Both paths failed.
  return { openId: null, source: "unresolved", botName, chatId };
}

// Backwards-compat wrapper: throws on null (older daemon code path).
// Prefer resolveBotOpenId in new code.
export async function resolveHostOpenId(appId, appSecret, chatId, botName) {
  const { openId, source } = await resolveBotOpenId(appId, appSecret, chatId, botName);
  if (openId) return openId;
  throw new Error(
    `cannot resolve open_id for bot "${botName}" in chat ${chatId}.\n` +
    `  Feishu's chats/.../members API does not return bot members; we also tried\n` +
    `  scanning recent messages for @-mentions matching "${botName}" — none found.\n` +
    `  Fixes (any one works):\n` +
    `    - Make any user/bot in the chat send a message that @-mentions ${botName} (one time);\n` +
    `      our resolver will pick up the open_id from message history.\n` +
    `    - OR add to your config: apps[<host>].openId = "ou_xxx" (the bot's open_id\n` +
    `      from THIS app's perspective, e.g. obtainable from a known message's\n` +
    `      mentions[] field where THIS app's token is the reader).\n` +
    `    - Verify the host bot is actually a member of the chat (Feishu UI).`
  );
}

// Extract user-visible text from a message body, given its msg_type.
// Feishu replaces <at> tags with literal "@_user_N" on retrieval — that's expected.
export function extractText(body, msgType) {
  try {
    const obj = JSON.parse(body);
    if (msgType === "text") return obj.text || "";
    if (msgType === "post") {
      const lines = (obj.content || []).map((line) =>
        line
          .map((seg) =>
            seg.tag === "at"
              ? `<at user_id="${seg.user_id || ""}">${seg.user_name || ""}</at>`
              : seg.text || ""
          )
          .join("")
      );
      return ((obj.title ? `**${obj.title}**\n` : "") + lines.join("\n")).trim();
    }
    return JSON.stringify(obj).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}
