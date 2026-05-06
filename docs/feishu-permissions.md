# Feishu permissions

oc-feishu-link talks to Feishu Open API on behalf of N self-built apps (one per agent). Each app must be configured in the Feishu developer console with the right scopes, event subscriptions, and group memberships.

**The host bot and member bots have different permission requirements.** Get this wrong and the discussion silently breaks.

## Required scopes

Open the developer console for each app → 应用 → 权限管理 → tick the appropriate scopes per role:

| Capability | Scope name | Host bot | Member bot |
|---|---|:---:|:---:|
| Get tenant_access_token | (built-in, no scope needed) | ✓ | ✓ |
| Read group messages (chat-level polling, kickoff detection) | `im:message.group_at_msg:readonly` | ✓ | (helpful for debugging) |
| Read group messages (thread-level polling) | (same as above; thread API uses same scope) | (not used) | ✓ |
| Read chat membership (resolve open_ids) | `im:chat.members:read` (or `im:chat:readonly`) | ✓ | (not strictly required) |
| Send messages as bot (host's reply_in_thread, daemon's free-speak posts) | `im:message:send_as_bot` | ✓ | ✓ |
| Receive @-mention events (member auto-reply via openclaw native plugin) | `im:message.group_msg` (event subscription) | (not used) | ✓ |
| Resolve sender display names (cosmetic; reduces "41050 no user authority" log noise) | `contact:user.base:readonly` | ✓ (optional) | ✓ (optional) |

**Submit the version** after ticking scopes. Same-tenant approval is usually instant.

## Group setup

For each Feishu group used in your config:

1. Settings → 群机器人 → 添加机器人 → select your app
2. Repeat for ALL apps in your config that reference this `chatId` (host + every member)
3. Confirm visibility: as the developer, run `oc-feishu-link link` — it will list each chat's visible members and warn if any expected bot is missing

## OpenClaw native lark plugin: enable / disable per role

Critical contract:

| Role | OpenClaw native lark plugin |
|---|---|
| Host bot | **DISABLED** |
| Member bot | **ENABLED** |

**Why**: in round-robin mode, members reply via openclaw's native plugin auto-firing on `@-mention` events. The host is driven entirely by the daemon (which forks `openclaw agent` directly via CLI). If the host's native plugin is also enabled, it double-fires alongside the daemon, creating two parallel threads per kickoff — daemon polls one, members reply into the other → silent stall.

**Apply**:

```bash
# Disable host native plugin (per host bot in your config):
openclaw config set channels.feishu.accounts.bot-<host_appId>.enabled false

# Ensure member native plugin is enabled (default; clear any stale override):
openclaw config unset channels.feishu.accounts.bot-<member_appId>.enabled

# Restart gateway so changes take effect:
systemctl --user restart openclaw-gateway     # if user systemd
# or: openclaw gateway restart                 # if managed by openclaw
```

**Verify**: `openclaw channels status --probe` should show every host bot as `disabled, configured, stopped, error:disabled` and every member bot as `enabled, configured, running, works`. The `oc-feishu-link link` command bundles this check.

## Common error codes

| Code | Meaning | Fix |
|---|---|---|
| `99991663` Invalid access token | tenant token failed / app delisted | Re-check appId/appSecret; rebuild app in console |
| `230001` Invalid container_id | thread expired (group dissolved or thread deleted) | Daemon cleans up automatically on next poll cycle |
| `41050` no user authority | Bot called a user-only API (typically display-name resolution) | Non-blocking noise; add `contact:user.base:readonly` scope to silence |
| `19001` not a chat member | Bot isn't in the group | Add bot to chat per "Group setup" above |
| `2200` Internal Error / `9499` | Transient Feishu API hiccup | Daemon retries on next poll; usually clears in <1 min |

## Triggering discussions: real user vs bot impersonation

Discussions are triggered when the daemon's `pollMain` sees an @-mention of the host in main chat. The mentioner can be:

1. **A real user** in the Feishu group — simplest, no extra setup. Just type `@OpenClaw-PM <topic>` in the group and hit send.
2. **A bot impersonating a user** — used for automated testing (`oc-feishu-link verify`) and CI. Daemon accepts mentions from any `app_id`-typed sender that is NOT the host itself. Use any of your member bots' app credentials to send `<at user_id="<host_open_id>">HostName</at> <topic>` via `POST /im/v1/messages`.

The third option (`im:message:send_as_user` scope to send as a real user via API) is only available to certain enterprise apps and is typically not approvable for self-built apps. We don't depend on it.

## Threat model / what can go wrong if misconfigured

- **Host native plugin enabled** → silent split-brain (two threads per kickoff, daemon stuck on the wrong one).
- **Wrong appSecret in config** → `99991663` on every poll, daemon log floods, no discussions happen.
- **Bot not in group** → `19001` on first poll for that chat; daemon will keep retrying forever. Visible in `oc-feishu-link link`.
- **Member native plugin disabled** → in round-robin mode, host @s the member but no reply ever comes. Discussion stalls at PM's first dispatch. Visible in `oc-feishu-link link` (member status).
- **`im:message:send_as_bot` scope missing on host** → host can't `reply_in_thread`, kickoff fails with `[post] err 50000` or similar.
- **Two daemons polling the same chat with overlapping start_times** → duplicate kickoffs from the same user message. `kickoffsInFlight` only dedupes within one daemon process. **Run only one daemon per group.**
