# Developer guide

This is the deep-dive companion to the README — read it after you've gotten the quickstart running and want to extend or debug.

## Table of contents
- [Architecture](#architecture)
- [Adding a new discussion mode](#adding-a-new-discussion-mode)
- [Customizing SOUL templates](#customizing-soul-templates)
- [Debugging a stalled discussion](#debugging-a-stalled-discussion)
- [Testing your changes](#testing-your-changes)

## Architecture

```
                     ┌──────────────────────────────────────┐
                     │  Feishu OpenAPI (open.feishu.cn)     │
                     └────────────▲─────────────▲───────────┘
                                  │ poll (2.5s) │ post reply
                                  │             │
                     ┌────────────┴─────────────┴───────────┐
                     │  oc-feishu-link daemon (one Node     │
                     │  process; per-chat async loops)      │
                     │                                       │
                     │  state[chatId].threads[tid]           │
                     │  tokenCache, threadToChatId           │
                     │  kickoffFromMain / invokeHostRR /     │
                     │  tryFreeSpeakStep                      │
                     └────────▲────────────────────┬─────────┘
                              │                    │
                              │ transcript files   │ execFileSync
                              │ (chat-id +         │ "openclaw agent
                              │  thread-id mirror) │  --agent X
                              ▼                    │  --message <prompt>"
                  ┌──────────────────┐             │
                  │  /var/lib/oc-... │             ▼
                  │  /shared/...md   │   ┌──────────────────────┐
                  └────▲─────────────┘   │  openclaw gateway    │
                       │                 │  (single proc)       │
                       │ cat by SOUL.md  │  per-agent SOULs     │
                       │ in member       │  native lark plugin  │
                       │ replies          │   - host: DISABLED   │
                       └─────────────────┤   - member: ENABLED  │
                                         └──────────────────────┘
```

Three contracts to remember:
1. **Discussion rules live in SOUL.md, not daemon.** The daemon enforces no turn order, no round count, no `[END]` semantics. It just tells the right LLM "your turn — here's the transcript".
2. **Host's openclaw native lark plugin must be disabled.** Member's must be enabled. Daemon refuses to start if violated.
3. **Transcript is ground truth.** Both daemon and agents derive state from it. Don't manipulate it manually.

## Adding a new discussion mode

Two new modes that should be straightforward (no daemon changes, only SOUL.md authoring):

- **Debate** — two agents argue opposing positions, host arbitrates. Implement as `round-robin` with `members.length === 2` and a host SOUL that says "alternate between member 1 and member 2; after N exchanges, output verdict + [END]".
- **Review committee** — multiple specialists review a proposal, host requires consensus. Implement as `round-robin` with a host SOUL that says "wait until each member emits ✅ before [END]".

Modes that need daemon changes:

- **True parallel composition** — multiple agents compose simultaneously, daemon resolves conflicts. Requires removing the serial constraint in `tryFreeSpeakStep` and adding a "post arbitration" step (e.g. host picks the most relevant of N replies). This is non-trivial and contradicts the architect-recommended "feels weird in real life" semantics.
- **Cross-thread context** — discussions reference prior discussions. Requires an external store keyed by chat_id; transcript is currently per-thread.
- **Human in-thread intervention** — currently `pollMain` only triggers kickoff from main-chat @-mentions. To handle a human @ in an active thread, extend `pollThread` to detect user senders and inject their message into transcript + nudge the host.

## Customizing SOUL templates

`templates/*.md.tpl` use Mustache-style `{{var}}` placeholders rendered by `lib/soul-templater.js`. Variables come from the per-agent context built in `bin/oc-feishu-link.js` `cmdInit` and `cmdLink`.

**Available host template variables**:
- `{{host.role}}` — display label
- `{{host.style}}` — free text describing tone / preferences (developer fills this)
- `{{sharedTranscriptPath}}` — `<transcriptDir>/transcript-<chat_id>.md`
- `{{roleBullets}}` — markdown bullet list of members
- `{{rosterTable}}` — markdown table mapping each member role → `<at user_id="ou_xxx">role</at>` snippet
- `{{rules.maxRounds}}` / `{{rules.maxMessages}}` / `{{rules.endKeyword}}`

**Available member template variables**:
- `{{member.role}}`, `{{member.style}}`, `{{member.behaviorClause}}` (the agent's domain rule, e.g. "only speak when discussion involves cost / margin / cash flow")
- `{{host.role}}` (so the member SOUL can reference its host)
- `{{modeLabel}}` — "轮流发言" or "自由发言"
- `{{sharedTranscriptPath}}`
- `{{rules.endKeyword}}`

To customize: copy `templates/host-round-robin.md.tpl` → your project, edit, then teach `init` to use it (or simply maintain your own `souls/<agent>.md` files and skip the template system). After `init` renders templates, you own `souls/*.md` — re-running `init` will not overwrite them unless you pass `--force`.

## Debugging a stalled discussion

Quick triage tree:

1. **`oc-feishu-link daemon status` says inactive?** Daemon crashed. Check `journalctl -u oc-feishu-link --since "10min ago"`.

2. **Daemon active but no `[user @host main]` event in log when you @ the host?**
   - Re-run `oc-feishu-link link` — likely `mentions[]` doesn't match `hostOpenId` (open_id resolution drift).
   - Check `pollMain`'s `mainProcessedIds` window — daemon restart re-reads ~30s of history; if your @ is older, it's filtered out.

3. **`[kickoff]` logged but no `[thread NEW]`?**
   - Look for `[kickoff] empty reply` (LLM returned nothing) or `[post] err <code>` (Feishu API error).
   - Run host invocation manually: `openclaw agent --agent <host> --message "test"` — confirms openclaw side is healthy.

4. **`[thread NEW]` logged but member doesn't auto-reply (round-robin)?**
   - Most common cause: PM's @-message has only the `<at>` tag with no other text. The @-ed member's openclaw plugin sees an empty body and returns 0 replies. Fixed in v10.2 by tightening the kickoff prompt; verify your host SOUL.md follows the "@ tag must be followed by an instruction" rule.
   - Or: member bot's openclaw native plugin is disabled. Run `openclaw channels status --probe`.

5. **Round-robin: `[trigger RR]` fires but next host invoke produces empty?** Likely an openclaw `Command failed` error. Check daemon log for `openclaw exit N: <stderr>` lines — daemon captures stderr explicitly.

6. **Free-speak: every agent returns `[FS skip]` and discussion never converges?**
   - All agents may legitimately have nothing to add — host should `[END]`.
   - If host also `[SKIP]`s indefinitely, its SOUL probably lacks the "if discussion exhausted, emit [END]" clause. Check `templates/host-free-speak.md.tpl` for the canonical wording.

## Testing your changes

A safe test loop on a dev box:

```bash
# Reset state without losing config/souls
sudo rm /var/log/oc-transcript.log
rm -f $TRANSCRIPT_DIR/transcript-*.md
for a in pm-host dev mkt-a qa; do
  rm -rf /root/.openclaw/agents/$a/sessions/*
done

# Restart daemon (preflight will run again)
sudo systemctl restart oc-feishu-link

# End-to-end test (no real-user token needed)
oc-feishu-link verify --chat oc_xxx --topic "test topic"

# Watch correlated logs in another terminal
oc-feishu-link logs --tail
```

Expect ~5-7 minutes for round-robin (5 rounds → ~13 messages) or ~8-12 minutes for free-speak (4 candidates × multiple rounds). If `verify` exits with `✓ END detected` you've passed.
