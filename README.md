# oc-feishu-link

Wire your existing OpenClaw agents into Feishu (Lark) group chats so they can debate, review, or brainstorm with each other — **driven by an orchestrator daemon, with discussion rules in each agent's `SOUL.md`, not hardcoded.**

Two collaboration modes ship out of the box:

| Mode | Who decides who speaks next | Trigger | Convergence |
|---|---|---|---|
| `round-robin` | Host bot @-mentions next member by SOUL.md order | Member auto-replies on `@` event | Host emits `[END]` when its SOUL says rounds are done |
| `free-speak` | Daemon polls each agent with a `[SKIP]` option | Agent's own LLM decides "speak / skip" | Host emits `[END]` when its SOUL says discussion is converged |

Everything that varies between projects (turn order, max rounds, when to converge, agent personas, what counts as "off topic") lives in `SOUL.md` and is enforced by the LLM. The daemon does mechanism only — polling, transcript bookkeeping, forking openclaw, posting replies.

## What this is, and what it isn't

**This is** a CLI tool that connects N pre-existing OpenClaw agents (which you've already created and tuned in your own `/path/to/oc/<agent>/workspace/`) to one or more Feishu groups, so they can hold a structured discussion when a user @-mentions a designated host bot.

**This isn't**:
- A way to create OpenClaw agents (use the OpenClaw CLI for that)
- A general-purpose Feishu bot SDK
- A replacement for OpenClaw's native lark plugin — we use it for member auto-reply in round-robin mode

## Prerequisites

Before installing this tool you must already have:

1. **A working OpenClaw gateway** running locally (or on your server) with N agents created. You should be able to run `openclaw agent --agent <name> --message "hi"` and get back a JSON response.
2. **N self-built Feishu apps** (one per agent), each with the scopes listed in [docs/feishu-permissions.md](docs/feishu-permissions.md). Each app must already be added to its target group(s) as a bot member.
3. **Node.js ≥ 18**, **`jq`** (for `link` and `verify` output), **`curl`** (used internally), and `systemctl` (optional, for `daemon` lifecycle commands).

## Install

```bash
npm install -g oc-feishu-link
oc-feishu-link --help
```

(Or clone this repo and `npm link` from it.)

## Quickstart — 5 commands to first discussion

```bash
# 1. Scaffold ./oc-feishu-link.json + ./souls/<agent>.md templates
oc-feishu-link init

# 2. Edit ./souls/<agent>.md to fill in business persona / style.
#    Then export the secrets your config references via ${ENV_VAR}.
export PM_HOST_SECRET=...; export DEV_SECRET=...; ...

# 3. Verify everything is wired correctly. Resolves bot open_ids,
#    checks openclaw channel state, group membership, scopes.
#    Outputs a checklist with ✓ / ⚠ / ✗.
oc-feishu-link link

# 4. Copy ./souls/<agent>.md into each agent's openclaw workspace
#    (the link command prints exact paths; this is intentionally a
#    manual step so you can review before overwriting).
cp ./souls/pm-host.md /root/oc/pm-host/workspace/SOUL.md
# ... repeat for each agent ...

# 5. Start the daemon. Pair with systemd in production.
oc-feishu-link daemon start

# Now in Feishu, @-mention the host bot in the group with your topic:
#   "@OpenClaw-PM 启动需求评审：搜索结果页加品牌专区"
# The host opens a thread, members speak, and discussion converges
# with a host-emitted [END] message.
```

For a deeper end-to-end smoke test that doesn't require you to type in Feishu:

```bash
oc-feishu-link verify --chat oc_xxx --topic "插件烟测"
# Triggers a discussion using a member bot's identity (no real-user
# token needed), then watches the chat until host emits [END] or
# 600s timeout.
```

## Config schema

`oc-feishu-link.json` — see [examples/oc-feishu-link.example.json](examples/oc-feishu-link.example.json) for a full annotated example.

Top-level fields:

```jsonc
{
  "version": 1,
  "openclawRoot": "/root/oc",            // required — where /<agent>/workspace lives
  "transcriptDir": "/root/oc/.shared",   // default: <openclawRoot>/.shared
  "openclawBin": "openclaw",             // command to invoke OpenClaw CLI
  "polling": { "intervalMs": 2500, "openclawTimeoutSec": 180 },
  "apps": [ /* see below */ ],
  "chats": [ /* see below */ ]
}
```

### `apps[]` — Feishu app ↔ openclaw agent (1:1)

```jsonc
{
  "appId": "cli_xxx",                   // Feishu self-built app
  "appSecret": "${PM_HOST_SECRET}",     // ${VAR} expands from process.env
  "agent": "pm-host",                   // openclaw agent name (must exist in <openclawRoot>/<agent>)
  "role": "产品助理",                    // display label used in transcript and SOUL roster
  "botName": "OpenClaw-PM"              // bot's display name in Feishu; required for open_id resolution
}
```

### `chats[]` — group ↔ topology

```jsonc
{
  "name": "ProductReview",              // free label (used in logs)
  "chatId": "oc_xxx",                   // Feishu group chat_id
  "mode": "round-robin",                // "round-robin" | "free-speak"
  "host": "pm-host",                    // references apps[].agent
  "members": ["dev", "mkt-a", "qa"],    // references apps[].agent
  "modeOptions": {
    // round-robin only:
    "maxRounds": 5,
    // free-speak only:
    "maxMessages": 25,
    "recentSpeakerCooldownMs": 8000,
    // both:
    "endKeyword": "[END]"
  }
}
```

`maxRounds` and `maxMessages` are **soft** bounds — they're communicated to the host LLM via SOUL.md, and the LLM is responsible for honoring them. The daemon does not enforce them as hard cutoffs (this is a known limitation; see "Risks").

### Secret handling

`appSecret` supports `${ENV_VAR}` interpolation. The loader will fail-fast if a referenced env var is missing, so you can't accidentally start the daemon with `"appSecret": "${UNSET}"` literal sent to Feishu's auth API.

You may also inline secrets, but you probably shouldn't — config files end up in git, terminal history, and remote backups.

## Architecture (one paragraph)

A single Node daemon polls Feishu's IM API every 2.5s per chat (each chat gets its own async loop, so one stuck LLM call in chat A doesn't freeze chat B). When a user (or non-host bot) @-mentions the host in a group, daemon forks `openclaw agent --agent <host>` to generate an opening message, posts it via `reply_in_thread:true` so a thread is created. From there:

- **Round-robin**: members' OpenClaw native lark plugin auto-replies when the host @s them (you must keep member native plugins **enabled** in openclaw config). After each member reply, daemon re-invokes the host to dispatch the next turn.
- **Free-speak**: the daemon itself polls each candidate (members + host) after each new transcript entry, with a `[SKIP]` option in the prompt. Agents that have nothing to add return `[SKIP]`; the first non-skipping reply gets posted via daemon → Feishu (using that agent's app token). Host typically only speaks to steer or to emit `[END]`.

Crucially, **host bots' OpenClaw native lark plugin must be DISABLED**. If both daemon and native plugin respond to host @-mentions, you get duplicate threads and silent failure. The daemon refuses to start if this isn't the case (preflight checks `openclaw channels status --probe`).

A shared transcript file is written for each thread (`<transcriptDir>/transcript-<thread_id>.md`) AND mirrored by chat_id (`transcript-<chat_id>.md`) — the latter is what each agent's SOUL.md tells them to `cat` before replying.

## Commands

| Command | Purpose |
|---|---|
| `init` | Interactive scaffold of `oc-feishu-link.json` + `souls/<agent>.md` from templates. Onboarding only — does not connect to Feishu. |
| `link` | Preflight + Feishu auth + group membership + open_id resolution + workspace SOUL.md presence. Outputs a ✓/⚠/✗ checklist. **Run after editing config or souls.** |
| `daemon start` | Starts the orchestrator (foreground). Pair with systemd in production. |
| `daemon status / stop / restart / logs` | Wraps `systemctl` for the optional `oc-feishu-link.service` unit (you provide). |
| `verify --chat <oc_xxx>` | End-to-end smoke test: triggers a discussion via a member bot, watches the chat until host emits `[END]` or 600s timeout. |
| `logs [--chat <oc_xxx>] [--tail]` | Correlated tail of daemon log + openclaw runtime log. |

## Roadmap / Known limitations

- **Soft bounds**: `maxRounds` and `maxMessages` are LLM-honored, not daemon-enforced. A misbehaving host could ignore them.
- **Single-process state**: thread state is in-memory. Daemon restart loses `processedIds`, `kickoffsInFlight`, etc. Old threads may be re-ingested on restart.
- **Cost scales with transcript size**: every invocation includes the full transcript. ~10-20 messages stays cheap; 50+ messages will dominate cost. Future versions will support host-maintained running summary.
- **Polling latency**: 2.5s × LLM time means user @-mention to host opening is typically 5-15s. Webhook/event subscription is faster but adds infrastructure complexity.
- **Single openclaw queue**: all agent invocations go through one openclaw gateway. Heavy concurrent discussions across many groups will queue up.

For more architectural commentary, see comments in [`lib/daemon.js`](lib/daemon.js).

## Documentation

- [docs/deployment.md](docs/deployment.md) — production deployment via systemd / pm2 / Docker, day-2 ops, pre-flight checklist
- [docs/feishu-permissions.md](docs/feishu-permissions.md) — exact Feishu scopes per app role (host vs member), how to wire OpenClaw native plugin enable/disable, common error codes
- [docs/developer-guide.md](docs/developer-guide.md) — extending modes, customizing SOUL templates, debugging stalled discussions

## License

MIT
