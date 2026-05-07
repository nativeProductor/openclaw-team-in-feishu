# Upgrading

## From v0.1.0 → v0.1.1+

**What changed**: the project was renamed from `oc-feishu-link` to `openclaw-team-in-feishu` (npm package name) and the CLI binary from `oc-feishu-link` to `octf`. Existing v0.1.0 installs reference the old binary in their systemd unit, so they need a one-time migration.

```bash
# 1. Stop the old service
sudo systemctl stop oc-feishu-link
sudo systemctl disable oc-feishu-link

# 2. Pull latest code + relink
cd /opt/openclaw-team-in-feishu  # (or wherever you cloned it)
git pull
sudo npm install --no-audit --no-fund
sudo npm link --no-audit --no-fund
which octf    # → /usr/bin/octf

# 3. Install the renamed systemd unit
sudo cp examples/octf.service /etc/systemd/system/octf.service
sudo systemctl daemon-reload
sudo systemctl enable --now octf

# 4. Optional cleanup: remove the old unit file
sudo rm /etc/systemd/system/oc-feishu-link.service

# 5. Confirm preflight passes (member bots' renderMode set correctly)
sudo journalctl -u octf --since "30s ago" --no-pager | grep preflight
# Expected: ✓ openclaw channels: N hosts disabled, M members enabled
```

If preflight fails because some member bot's `renderMode` is unset (default openclaw state), run:
```bash
cd /etc/octf
sudo bash -c 'set -a; source secrets.env; set +a; octf link --apply'
sudo systemctl restart octf
```

## Config file location

The config filename is unchanged — `octf.json`. The default config dir conventions also unchanged. If your old install used `/etc/oc-feishu-link/oc-feishu-link.json` you may move it to `/etc/octf/octf.json` for consistency, but octf.json is still picked up from any of the legacy paths.
