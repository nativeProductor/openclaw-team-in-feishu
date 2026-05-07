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
- Isn't a general Feishu bot framework

> **v0.1.2 contract change.** From v0.1.2 onwards the daemon owns *all* dispatch — every bot's OpenClaw native Feishu plugin must be **disabled**. The previous "host disabled / member enabled" split is gone. This unblocks multi-chat agents (the same agent can serve multiple Feishu groups). If you're upgrading from v0.1.1, see [docs/upgrading.md](docs/upgrading.md).

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
              │  (single process, one async loop per chat,   │
              │   per-agent global mutex serializes invokes) │
              └────────▲────────────────────┬────────────────┘
                       │                    │ execFileSync
            transcript │                    │ "openclaw agent
            inject     │                    │  --agent X
            (per       │                    │  --message <transcript+task>"
            invoke)    │                    ▼
            ┌──────────┴───────┐   ┌──────────────────────┐
            │ /shared/         │   │  openclaw gateway    │
            │ transcript-*.md  │   │  per-agent SOULs     │
            │ (daemon's        │   │  Feishu plugin:      │
            │  bookkeeping)    │   │   ALL bots DISABLED  │
            └──────────────────┘   │  (daemon owns reply) │
                                   └──────────┬───────────┘
                                              │ stdout: agent's reply text
                                              ▼
                                   daemon POSTs as the right bot →
                                   reply lands in thread
```

### Three contracts

1. **Discussion rules live in `SOUL.md`, not the daemon.** Turn order, max rounds, when to emit `[END]`, when to emit `[SKIP]` — all enforced by each agent's LLM reading its `SOUL.md`. The daemon does mechanism only: poll, inject transcript into prompts, fork openclaw, post replies. Changing the discussion shape (debate / review / brainstorm) means editing `SOUL.md` — daemon code does not change.
2. **All bots' OpenClaw Feishu plugins must be disabled.** The daemon owns every reply: it watches the Feishu thread, invokes the right OpenClaw agent via CLI (with the current transcript injected into the prompt), and posts the reply itself using that bot's token. If any bot's native plugin is left enabled, you get double-fire — the daemon enforces this with a startup preflight check.
3. **Transcript files are daemon-only state.** Each thread's transcript is written by the daemon to `transcript-<thread_id>.md` and mirrored to `transcript-<chat_id>.md`. Agents *do not* `cat` these files — daemon injects the relevant transcript into each invocation's prompt directly. This decouples `SOUL.md` from any specific chat, which is what enables a single agent to serve multiple Feishu groups.

### Modes

| | round-robin | free-speak |
|---|---|---|
| Who picks next speaker | Host @-mentions members per `SOUL.md` order | Daemon polls each agent with a `[SKIP]` option; agents decide |
| Member trigger | Daemon detects host's @-mention in the thread, invokes that member via openclaw CLI, posts the reply as the member bot | Daemon directly invokes each candidate via openclaw CLI in shuffled order |
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
- **Every bot's OpenClaw Feishu plugin must be disabled** (daemon owns dispatch since v0.1.2). The daemon enforces this at startup; misconfigured bots refuse to come up.

### Runtime

- Node.js ≥ 18
- `openclaw` CLI on `PATH`
- `jq`, `curl` (used by examples)

---

## Installation

```bash
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git
cd openclaw-team-in-feishu
npm install --no-audit --no-fund
sudo npm link --no-audit --no-fund
octf --help
```

(`--no-audit --no-fund` skips registry-side checks that can be slow on some networks; functional install is unaffected.)

---

## Quick start

```bash
# 1. Scaffold config + SOUL templates
mkdir -p /etc/octf && cd /etc/octf

# Interactive Q&A:
octf init

# OR template-based (faster if you have many agents):
#   octf init --template > my-config.json
#   $EDITOR my-config.json     # fill in cli_xxx / oc_xxx / agents / members
#   octf init --from my-config.json

# 2. Edit each SOUL with your business persona / behavior rules
$EDITOR souls/pm-host.md   # ... and one per agent

# 3. Set the secrets your config references via ${VAR}
export PM_HOST_SECRET=...; export DEV_SECRET=...
# (recommended: put them in /etc/octf/secrets.env, chmod 600)

# 4. Validate, auto-resolve open_ids, patch SOUL rosters, AND deploy souls
#    into agent workspaces — all in one step:
octf link --apply

# 5. Start the daemon
octf daemon start
```

In your Feishu group: `@<host_bot> <topic>`. The host opens a thread and the discussion runs to convergence.

### Adding a chat later

To bind your existing team to a new Feishu group (after `init`):

```bash
# 1. Add the host + members to the new Feishu group as bot members.
# 2. Bind it via:
octf chat add \
  --chat oc_NEW_GROUP_ID \
  --mode round-robin \
  --host pm-host \
  --members dev,mkt-a,qa \
  --max-rounds 5

# 3. Resolve open_ids, patch SOUL rosters, and deploy souls to workspaces:
octf link --apply

# 4. Restart daemon to pick up the new chat:
octf daemon restart
```

To unbind: `octf chat remove --chat oc_xxx`. To see all bound chats: `octf chat list`.

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
| `octf chat add\|remove\|list` | Bind / unbind / list Feishu groups your team serves |
| `octf link [--apply]` | Validate wiring (auth, channels, membership, SOUL.md presence). With `--apply`: resolve member open_ids, patch them into local `souls/<host>.md` rosters, and deploy `souls/*.md` into each agent's workspace |
| `octf daemon <start\|stop\|restart\|status\|logs>` | Run the orchestrator |
| `octf verify --chat <oc_xxx> [--topic "..."] [--timeout 600]` | End-to-end smoke test |
| `octf logs [--tail]` | Tail correlated daemon + openclaw logs |

---

## Documentation

- [docs/deployment.md](docs/deployment.md) — production deployment via systemd / pm2 / Docker
- [docs/upgrading.md](docs/upgrading.md) — version migration notes (start here when pulling a newer release)
- [docs/feishu-permissions.md](docs/feishu-permissions.md) — Feishu scopes per role, error codes, threat model
- [docs/developer-guide.md](docs/developer-guide.md) — architecture, adding modes, debugging

---

## Limitations

- `maxRounds` and `maxMessages` are soft bounds (LLM-honored, not daemon-enforced).
- Each agent invocation receives the full thread transcript injected into its prompt — input cost scales O(N²) with cumulative message count. Default 5×5 = 25-message cap is fine; past that, cost rises noticeably.
- Polling cadence is 2.5s; user-to-host latency is typically 5–15s.
- **Cross-chat parallelism boundary.** Different agents across chats run in parallel (independent per-chat async loops, gated only by your OpenClaw gateway's LLM concurrency). The **same** agent invoked from two chats simultaneously is serialized by a per-agent mutex (prevents OpenClaw session corruption). Net effect: the more two chats share members, the more serial they become.
- Threads can only be ended by the host bot emitting `[END]`; humans cannot interrupt mid-discussion by posting in the thread.
- Adding/removing a chat or rotating secrets requires `octf daemon restart` (config + env vars are loaded at startup). **Editing `SOUL.md` does NOT require a restart** — the daemon never reads SOUL files; each `openclaw agent` invocation reads SOUL fresh from disk.
- Daemon state is in-process memory; an unexpected restart loses the message-dedup table (worst case: one boundary message gets re-processed once).

> **Production deployment note.** Since v0.1.2 the daemon owns all dispatch (every bot's native Feishu plugin is disabled). If the daemon process is down, no bot replies — even to direct mentions. Run under systemd with `Restart=always` or equivalent. See [docs/deployment.md](docs/deployment.md).

---

## License

MIT — see [LICENSE](LICENSE).
