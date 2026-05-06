// Resolve each member role's open_id from the host bot's perspective.
// open_ids are per-app-scoped on Feishu; the host bot's tokens see member bots
// under different open_ids than the member bot would see for itself. We need
// the host's view because that's the open_id the host LLM will write into
// <at user_id="ou_xxx">role</at> tags.

import { getTenantToken, listChatMembers } from "./feishu.js";

export async function resolveRoster(group) {
  const token = await getTenantToken(group.host.appId, group.host.appSecret);
  const r = await listChatMembers(token, group.chatId, { pageSize: 100 });
  if (r.code !== 0) {
    throw new Error(`listChatMembers (host=${group.host.appId}, chat=${group.chatId}): code=${r.code} msg=${r.msg}`);
  }
  const items = r.data?.items || [];

  // Match each declared member to its bot row by display name (botName field).
  // If botName isn't given, fall back to fuzzy match by role label.
  const roster = [];
  const unmatched = [];
  for (const m of group.members) {
    const target = (m.botName || m.role || "").trim();
    let row = items.find((it) => it.name === target);
    if (!row && m.role) row = items.find((it) => (it.name || "").includes(m.role));
    if (row) {
      roster.push({ ...m, openId: row.member_id, displayName: row.name });
    } else {
      unmatched.push(m);
    }
  }
  return { roster, unmatched, allMembers: items };
}
