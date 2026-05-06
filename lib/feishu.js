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

// Resolve the host bot's open_id from the host's own perspective in a given
// chat. Feishu issues per-app open_ids — same bot has different ids depending
// on which app is reading. The daemon's pollMain matches incoming @-mentions
// against this id, so we have to query it once at startup.
export async function resolveHostOpenId(appId, appSecret, chatId, botName) {
  const token = await getTenantToken(appId, appSecret);
  const r = await listChatMembers(token, chatId, { pageSize: 100 });
  if (r.code !== 0) {
    throw new Error(`resolveHostOpenId(${appId}, chat=${chatId}): code=${r.code} msg=${r.msg}`);
  }
  const items = r.data?.items || [];
  const exact = items.find(it => it.name === botName);
  if (exact) return exact.member_id;
  const fuzzy = items.find(it => (it.name || "").includes(botName));
  if (fuzzy) return fuzzy.member_id;
  throw new Error(
    `resolveHostOpenId: no member matching botName "${botName}" in chat ${chatId}. ` +
    `Visible members: ${items.map(i => i.name).join(", ")}. ` +
    `Either fix botName in config to match the bot's display name in Feishu, ` +
    `or invite the host bot to the chat.`
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
