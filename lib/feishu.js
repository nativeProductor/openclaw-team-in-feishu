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

// Resolve member open_ids from a HOST'S perspective. Used to fill the
// rosterTable in host-mode SOULs. Scans recent chat messages with the host's
// token, looks for `mentions[]` entries matching each member's botName.
//
// Returns { roleName: openIdString } map; missing members map to null.
//
// Why host's token: when the host's own LLM later writes
// `<at user_id="ou_xxx">role</at>`, the open_id must be from the host's
// perspective. Open_ids stored in `mentions[].id` reflect the SENDER's
// perspective at write time. So scanning history with the host's token
// finds messages — but `mentions[].id` is the SENDER's open_id resolution,
// not the host's. The reliable trick: find any message that the HOST itself
// once posted with an `<at>` to the target member — those `mentions[].id`
// values WERE written by the host and ARE correct from host's perspective.
export async function resolveMemberOpenIdsForHost(hostAppId, hostAppSecret, chatId, memberBotNames, { pageSize = 50 } = {}) {
  const token = await getTenantToken(hostAppId, hostAppSecret);
  const result = {};
  for (const name of memberBotNames) result[name] = null;

  // Strategy 1: messages sent BY the host (sender.id === hostAppId) with mentions.
  try {
    const lr = await listChatMessages(token, chatId, { pageSize, sort: "ByCreateTimeDesc" });
    if (lr.code === 0) {
      for (const msg of lr.data?.items || []) {
        if (msg.sender?.id_type !== "app_id" || msg.sender?.id !== hostAppId) continue;
        for (const mention of (msg.mentions || [])) {
          for (const name of memberBotNames) {
            if (result[name]) continue;
            if (mention.name === name || (mention.name || "").includes(name)) {
              result[name] = mention.id;
            }
          }
        }
      }
    }
  } catch {}

  // Strategy 2: any other message (sender != host) that mentions this member —
  // open_id is from the SENDER's perspective. For users in the same tenant,
  // this often (but not always) matches the host's perspective. Use as
  // fallback only when strategy 1 didn't resolve the name.
  if (Object.values(result).some(v => v == null)) {
    try {
      const lr = await listChatMessages(token, chatId, { pageSize, sort: "ByCreateTimeDesc" });
      if (lr.code === 0) {
        for (const msg of lr.data?.items || []) {
          for (const mention of (msg.mentions || [])) {
            for (const name of memberBotNames) {
              if (result[name]) continue;
              if (mention.name === name || (mention.name || "").includes(name)) {
                result[name] = mention.id;
              }
            }
          }
        }
      }
    } catch {}
  }
  return result;
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
//
// Handles four msg_type cases:
//   text        — { text: "..." }                        → return text
//   post        — { title?: "...", content: [[{tag,text}, ...], ...] } → flatten lines
//   interactive — { header?: {...}, elements: [...] }    → recursive walk for any
//                 string-valued `text` / `content` / `text_run.text` field. This
//                 is what OpenClaw's Feishu plugin emits when content is long
//                 or structured (renderMode=auto). Without this case, transcript
//                 entries become unreadable JSON dumps and the host LLM thinks
//                 the message is corrupted.
//   anything else — best-effort recursive walk
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
    if (msgType === "interactive") {
      return extractInteractive(obj);
    }
    // Unknown msg_type — try recursive walk before giving up.
    const fallback = walkForText(obj);
    return fallback || JSON.stringify(obj).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}

// Render an interactive card to plain text.
//   header.title.content → bold-prefixed first line
//   elements[].text.content / .content / .text_run.text → flowed paragraphs
//   columns / column_set → recursively walked
//   div / markdown / plain_text / hr → text where applicable, "---" for hr
function extractInteractive(card) {
  const out = [];
  const headerTitle = card?.header?.title?.content;
  if (headerTitle) out.push(`**${headerTitle}**`);
  for (const el of card?.elements || []) {
    out.push(renderElement(el));
  }
  return out.filter(Boolean).join("\n\n").trim();
}

function renderElement(el) {
  if (!el || typeof el !== "object") return "";
  const tag = el.tag;
  // Common text-bearing shapes
  if (tag === "div" || tag === "markdown") {
    if (el.text?.content) return String(el.text.content);
    if (typeof el.content === "string") return el.content;
  }
  if (tag === "plain_text" || tag === "text") {
    return el.content || el.text || "";
  }
  if (tag === "hr") return "---";
  if (tag === "img") return el.alt?.content ? `[image: ${el.alt.content}]` : "[image]";
  if (tag === "column_set" && Array.isArray(el.columns)) {
    return el.columns.map((c) =>
      (c.elements || []).map(renderElement).filter(Boolean).join("\n")
    ).filter(Boolean).join("\n\n");
  }
  if (tag === "action" && Array.isArray(el.actions)) {
    return el.actions.map((a) => a.text?.content).filter(Boolean).join(" | ");
  }
  // Fallback: walk anything text-shaped under this element.
  return walkForText(el);
}

// Recursive depth-first walk: collect any string under keys named
// "content", "text", or any "text_run.text". Joins with newlines.
function walkForText(node) {
  const acc = [];
  const visit = (n) => {
    if (n == null) return;
    if (typeof n === "string") return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (typeof n !== "object") return;
    if (typeof n.content === "string" && n.content.trim()) acc.push(n.content);
    if (typeof n.text === "string" && n.text.trim()) acc.push(n.text);
    if (n.text_run && typeof n.text_run.text === "string" && n.text_run.text.trim()) {
      acc.push(n.text_run.text);
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(node);
  // de-dupe consecutive identical lines (a card often nests the same content)
  const out = [];
  for (const s of acc) if (out[out.length - 1] !== s) out.push(s);
  return out.join("\n").trim();
}
