# openclaw-team-in-feishu

> Make your OpenClaw agents collaborate in Feishu groups. Two built-in modes: **round-robin** (host calls on each member in turn) and **free-speak** (members decide when to chime in).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[简体中文](README.zh-CN.md) · English

---

## Overview

You've built N OpenClaw agents — each runs and responds individually. This project wires them into one or more Feishu groups so they can hold a structured discussion: a user @-mentions the host bot with a topic, the host opens a thread, members contribute one by one, and the host emits a closing summary when the conversation has converged.

**What it does**

1. Watches each Feishu group's main chat for `@host` mentions
2. Invokes the host agent to open a thread with the topic confirmed
3. Drives subsequent dialogue using one of two modes (configurable per group)
4. Stops when the host emits the configured end keyword (`[END]` by default)

**What it doesn't**

- Doesn't create OpenClaw agents (use OpenClaw's own CLI)
- Doesn't replace OpenClaw's Feishu plugin (member auto-reply in round-robin mode depends on it)
- Isn't a general Feishu bot framework

---

## How it works

```
                    ┌──────────────────────────────────────┐
                    │  Feishu Open API (open.feishu.cn)    │
                    └────────▲────────────────▲────────────┘
              poll main chat │                │ post replies
              (detect @host) │                │ (reply_in_thread:true)
                             │                │
              ┌──────────────┴────────────────┴──────────────┐
              │  octf daemon                                 │
              │  (single process, one async loop per chat)   │
              └────────▲────────────────────┬────────────────┘
                       │                    │ execFileSync
            transcript │                    │ "openclaw agent
            (thread-id │                    │  --agent X
            + chat-id  │                    │  --message <prompt>"
            mirror)    │                    ▼
            ┌──────────┴───────┐   ┌──────────────────────┐
            │ /shared/         │   │  openclaw gateway    │
            │ transcript-*.md  │   │  per-agent SOULs     │
            └────────▲─────────┘   │  Feishu plugin:      │
                     │             │   host    DISABLED   │
                     │ cat by      │   members ENABLED    │
                     │ each agent  │                      │
                     │ before      └──────────┬───────────┘
                     │ replying              │ member @-mention auto-fires
                     │                        │ (round-robin only)
                     │                        ▼
                     └─────────────── reply lands in thread
```

### Three contracts

1. **Discussion rules live in `SOUL.md`, not the daemon.** Turn order, max rounds, when to emit `[END]`, when to emit `[SKIP]` — all enforced by each agent's LLM reading its `SOUL.md`. The daemon does mechanism only: poll, write transcripts, fork openclaw, post replies. Changing the discussion shape (debate / review / brainstorm) means editing `SOUL.md` — daemon code does not change.
2. **The host bot's OpenClaw Feishu plugin must be disabled; member bots' must be enabled.** With both enabled, host responses double-fire, creating duplicate threads and silent stalls. The daemon enforces this with a startup preflight check.
3. **Transcript files are the single source of truth.** Both daemon and agents read state from the same Markdown files. Each message is appended once and mirrored under both `<thread_id>.md` (daemon's bookkeeping) and `<chat_id>.md` (path that `SOUL.md` instructs each agent to `cat`).

### Modes

| | round-robin | free-speak |
|---|---|---|
| Who picks next speaker | Host @-mentions members per `SOUL.md` order | Daemon polls each agent with a `[SKIP]` option; agents decide |
| Member trigger | OpenClaw Feishu plugin auto-fires on `@-mention` | Daemon directly invokes via openclaw CLI |
| Convergence | Host emits `[END]` at max rounds or when sufficient | Host emits `[END]` once domains are covered or limit reached |
| Best for | Reviews, planning sessions where every role must speak | Brainstorming, decisions where each domain decides relevance |

### When can the host end a discussion?

The host can emit `[END]` at any of its invocation points — it is not forced to wait for `maxRounds` or `maxMessages`. Each invocation passes the full transcript to the host's LLM, which decides per its `SOUL.md` whether to output a closing summary + `[END]` or to continue. Invocation cadence:

- **round-robin**: after every member reply
- **free-speak**: at least once per polling cycle (host is the tail candidate when daemon walks the queue)

Only the host bot's `[END]` ends a thread. A human or other bot posting `[END]` in the thread is treated as content, not as a control signal.

---

## Prerequisites

### OpenClaw

- OpenClaw gateway running (`openclaw channels status --probe` lists your bot channels)
- Each agent created at `<openclawRoot>/<agent>/workspace/`
- `openclaw agent --agent <name> --message "test"` returns a valid response

### Feishu

- N self-built apps (one per agent, including the host)
- Each app added to its target group(s) as a bot member
- Required scopes per role — see [docs/feishu-permissions.md](docs/feishu-permissions.md)
- For each group: host bot's OpenClaw Feishu plugin disabled, member bots' enabled

### Runtime

- Node.js ≥ 18
- `openclaw` CLI on `PATH`
- `jq`, `curl` (used by examples)

---

## Installation

```bash
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git
cd openclaw-team-in-feishu
npm install
sudo npm link
octf --help
```

---

## Quick start

```bash
# 1. Scaffold config + SOUL templates (interactive)
mkdir -p /etc/octf && cd /etc/octf
octf init

# 2. Edit each SOUL with your business persona / behavior rules
$EDITOR souls/pm-host.md   # ... and one per agent

# 3. Set the secrets your config references via ${VAR}
export PM_HOST_SECRET=...; export DEV_SECRET=...
# (recommended: put them in /etc/octf/secrets.env, chmod 600)

# 4. Validate the wiring + auto-resolve open_ids into SOUL rosters
octf link --apply

# 5. Deploy SOULs into agent workspaces
for a in pm-host dev mkt-a qa; do
  cp souls/$a.md /path/to/oc/$a/workspace/SOUL.md
done

# 6. Start the daemon
octf daemon start
```

In your Feishu group: `@<host_bot> <topic>`. The host opens a thread and the discussion runs to convergence.

---

## Testing

```bash
octf verify --chat <oc_xxx> --topic "smoke test"
```

`verify` triggers a discussion using a member bot's identity (no real-user token needed), watches the thread, and exits 0 once the host emits `[END]` or 1 on timeout.

---

## Configuration

```jsonc
{
  "version": 1,
  "openclawRoot": "/path/to/oc",
  "transcriptDir": "/path/to/oc/.shared",
  "polling": { "intervalMs": 2500, "openclawTimeoutSec": 180 },

  "apps": [
    { "appId": "cli_xxx",
      "appSecret": "${PM_HOST_SECRET}",
      "agent": "pm-host",
      "role": "Product",
      "botName": "ProductBot" }
  ],

  "chats": [
    { "name": "ProductReview",
      "chatId": "oc_xxx",
      "mode": "round-robin",
      "host": "pm-host",
      "members": ["dev", "mkt", "qa"],
      "modeOptions": { "maxRounds": 5, "endKeyword": "[END]" } }
  ]
}
```

Full annotated example: [examples/octf.example.json](examples/octf.example.json).

---

## Commands

| Command | Purpose |
|---|---|
| `octf init` | Interactive scaffold of config + SOUL templates |
| `octf link [--apply]` | Validate wiring; with `--apply`, patch resolved open_ids into SOUL rosters |
| `octf daemon <start\|stop\|restart\|status\|logs>` | Run the orchestrator |
| `octf verify --chat <oc_xxx> [--topic "..."] [--timeout 600]` | End-to-end smoke test |
| `octf logs [--tail]` | Tail correlated daemon + openclaw logs |

---

## Documentation

- [docs/deployment.md](docs/deployment.md) — production deployment via systemd / pm2 / Docker
- [docs/feishu-permissions.md](docs/feishu-permissions.md) — Feishu scopes per role, error codes, threat model
- [docs/developer-guide.md](docs/developer-guide.md) — architecture, adding modes, debugging

---

## Limitations

- `maxRounds` and `maxMessages` are soft bounds (LLM-honored, not daemon-enforced)
- Daemon state is in-process memory; restart loses dedup tables
- Each agent invocation receives the full transcript (input scales with cumulative message count)
- Polling cadence is 2.5s; user-to-host latency is typically 5–15s
- Single OpenClaw gateway = single LLM queue across all groups
- Threads can only be ended by the host bot emitting `[END]`; humans cannot interrupt mid-discussion by posting in the thread

---

## License

MIT — see [LICENSE](LICENSE).
