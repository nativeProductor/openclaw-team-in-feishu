# Deployment guide

How to take `oc-feishu-link` from `npm install` to a daemon running 24/7 on your server.

This assumes you've already done the work in [README.md](../README.md):
- Created your Feishu apps (one per agent)
- Created the OpenClaw agents (`/path/to/oc/<agent>/workspace/...`)
- Added each bot to its target group(s)

Skip ahead if you've done it; pick whichever approach fits your environment.

## Option 1 — `systemd` (recommended for production)

The most common shape: install globally, run as a system unit, secrets in a root-only env file.

### One-time setup

```bash
# 1. Install. v0.1 isn't on npm registry yet — clone + npm link:
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git /opt/oc-feishu-link
cd /opt/oc-feishu-link
sudo npm install
sudo npm link
which oc-feishu-link    # → /usr/bin/oc-feishu-link or similar

# 2. Create config + secrets directory.
sudo mkdir -p /etc/oc-feishu-link

# 3. Run init in that dir. MUST be in an interactive terminal (TTY) —
#    `init` doesn't accept piped stdin (it'd silently lose answers).
cd /etc/oc-feishu-link
sudo oc-feishu-link init

# 4. Edit ./souls/<agent>.md to fill in business persona / style / behavior clauses.
sudo $EDITOR souls/pm-host.md     # repeat per agent

# 5. Create the secrets file (root-only).
sudo $EDITOR /etc/oc-feishu-link/secrets.env
```

`secrets.env` content (one line per env var your config references):
```
PM_HOST_SECRET=...
DEV_SECRET=...
MKT_A_SECRET=...
QA_SECRET=...
```

```bash
sudo chmod 600 /etc/oc-feishu-link/secrets.env

# 6. Validate the wiring before starting the daemon.
cd /etc/oc-feishu-link
sudo bash -c 'set -a; source secrets.env; set +a; oc-feishu-link link --config /etc/oc-feishu-link/oc-feishu-link.json'
```

Expected: `link` reports a checklist with mostly `✓`. Fix any `✗`.

### Push SOULs into agent workspaces

`init` writes `souls/<agent>.md`. The daemon does NOT auto-deploy these into agents' OpenClaw workspaces — you copy them yourself, on purpose, so you can review:

```bash
for agent in pm-host dev mkt-a qa; do
  sudo cp /etc/oc-feishu-link/souls/$agent.md /root/oc/$agent/workspace/SOUL.md
done
```

(Re-running `init` doesn't overwrite this; it only edits `/etc/oc-feishu-link/souls/`.)

### Install + enable the systemd unit

```bash
sudo cp /usr/lib/node_modules/oc-feishu-link/examples/oc-feishu-link.service \
        /etc/systemd/system/oc-feishu-link.service

sudo systemctl daemon-reload
sudo systemctl enable oc-feishu-link
sudo systemctl start oc-feishu-link

# Watch it start (preflight runs first; should see "✓ openclaw channels: …").
sudo journalctl -u oc-feishu-link -f --no-pager
```

If preflight fails, the daemon refuses to start and journalctl shows the exact violations + fix commands. Apply them and `sudo systemctl restart oc-feishu-link`.

### Smoke test the deployment

```bash
sudo -E env $(cat /etc/oc-feishu-link/secrets.env | xargs) \
  oc-feishu-link verify --chat oc_xxx --config /etc/oc-feishu-link/oc-feishu-link.json
```

This sends a synthetic trigger via one of your member bots, then watches the chat for the host's `[END]` message. Pass = deployment works end-to-end.

### Day 2 ops

```bash
sudo systemctl status oc-feishu-link        # health
sudo systemctl restart oc-feishu-link       # apply config / soul changes
sudo journalctl -u oc-feishu-link -f        # live tail
```

To upgrade:
```bash
sudo npm install -g oc-feishu-link@latest
sudo cp /usr/lib/node_modules/oc-feishu-link/examples/oc-feishu-link.service \
        /etc/systemd/system/oc-feishu-link.service   # if unit file changed
sudo systemctl daemon-reload
sudo systemctl restart oc-feishu-link
```

## Option 2 — `pm2` (Node ecosystem, no systemd)

If you don't have systemd (e.g. Docker, macOS dev), use `pm2`:

```bash
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git
cd openclaw-team-in-feishu && npm install && sudo npm link
npm install -g pm2

cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: "oc-feishu-link",
    script: "oc-feishu-link",
    args: "daemon start --config /path/to/oc-feishu-link.json",
    env: {
      PM_HOST_SECRET: "...",
      DEV_SECRET: "...",
      // ...
    },
    autorestart: true,
    max_restarts: 5,
    min_uptime: "30s",
  }]
}
EOF

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup     # follow the printed instructions to register pm2 at boot
```

Operations: `pm2 logs oc-feishu-link`, `pm2 restart oc-feishu-link`, `pm2 status`.

## Option 3 — Docker

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache jq curl
RUN npm install -g oc-feishu-link
WORKDIR /etc/oc-feishu-link
COPY oc-feishu-link.json ./
COPY souls/ ./souls/
# Secrets via Docker env / Docker secret, NOT baked into the image.
CMD ["oc-feishu-link", "daemon", "start", "--config", "/etc/oc-feishu-link/oc-feishu-link.json"]
```

Run with:
```bash
docker run -d \
  -v /var/lib/oc-feishu-link/shared:/var/lib/oc-feishu-link/shared \
  --env-file /path/to/secrets.env \
  --name oc-feishu-link \
  yourorg/oc-feishu-link
```

The OpenClaw gateway runs in a different container or on the host — `oc-feishu-link` shells out to the `openclaw` CLI, so the binary needs to be reachable. Mount the OpenClaw home or expose it via a network call accordingly.

## Pre-flight checklist (before going live)

- [ ] All Feishu app scopes granted and version submitted (see [feishu-permissions.md](feishu-permissions.md))
- [ ] All bots added to their target groups
- [ ] Host bot's openclaw native plugin **disabled**, member bots' **enabled**
- [ ] `oc-feishu-link link` reports 0 ✗
- [ ] `oc-feishu-link verify --chat <each chatId>` exits with `✓ END detected` for every group in your config
- [ ] Secrets file is `chmod 600` and not in git
- [ ] Daemon log directory writable by the user systemd runs as
- [ ] Backup / rotation for `<transcriptDir>/transcript-*.md` (these grow indefinitely)
- [ ] Monitoring alert on `journalctl -u oc-feishu-link --since "5min ago" | grep -i error` (basic health signal)

## Gotchas

- **Daemon crashes on preflight failure** — this is by design (see README "Architecture"). Read the violations in journalctl and apply them.
- **First @ after deploy might miss the kickoff window** — daemon's `mainProcessedIds` starts empty and `mainLastTime = now - 30s`. If you @ the host within the same 30s as deploy, you may miss the first event. Wait 30s after deploy before triggering.
- **Config / SOUL changes need a daemon restart** — they're loaded at startup only.
- **Free-speak runs are slow** — N member-invocations + transcript of growing size. Plan for ~10 minutes per discussion in the worst case.
