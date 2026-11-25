# Run Mission Control on a work Mac

Use this runbook when the Mac only needs to show and help with local cmux sessions. It does not
need GitHub, repositories, loops or crew. It takes about 15 minutes.

Mission Control stays on this Mac. The hub listens only on `127.0.0.1`. Session names, terminal
text and transcripts stay local. FLIGHT can send the facts it needs to its model provider.

## 1. Install the tools

Install Node 26 or later and pnpm 11. Confirm both commands are available:

```sh
brew install node
npm install -g pnpm@11
node --version
pnpm --version
```

Install cmux and start it once. In `~/.config/cmux/cmux.json`, give automation access to its socket:

```json
{
  "automation": { "socketControlMode": "automation" }
}
```

Keep any other cmux settings in the same JSON object. Restart cmux after changing the file.

## 2. Clone and build

Choose a folder that is not a working checkout you edit. Replace the placeholders before running
the commands:

```sh
export MC_HUB_DIR="$HOME/code/mission-control-hub"
git clone https://github.com/Luke-Bradford/mission-control.git "$MC_HUB_DIR"
cd "$MC_HUB_DIR"
pnpm install
pnpm build
```

## 3. Write the sessions-only config

The example has no accounts, repositories, loops or crew. Copy it as the hub configuration:

```sh
export MC_CONFIG_DIR="$HOME/.config/mission-control"
mkdir -p -m 700 "$MC_CONFIG_DIR"
cp "$MC_HUB_DIR/config.example.yaml" "$MC_CONFIG_DIR/config.yaml"
chmod 600 "$MC_CONFIG_DIR/config.yaml"
```

Do not add a `crew` section. GitHub is optional: without `gh`, repository and pull-request rows
show none. If you later add repositories, sign in with `gh auth login` first.

## 4. Choose local service settings

Choose an unused port and a launchd label. Keep the data directory private:

```sh
export MC_PORT=7431
export MC_LABEL=local.mission-control.work
export MC_DATA="$HOME/.local/share/mission-control-work"
export MC_LOG_DIR="$HOME/Library/Logs/mission-control-work"
mkdir -p -m 700 "$MC_DATA" "$MC_LOG_DIR"
```

## 5. Start once and save the operator token

Start the hub in the foreground to create its database and operator token. Stop it with Control-C
after the health request succeeds:

```sh
cd "$MC_HUB_DIR"
MC_CONFIG="$MC_CONFIG_DIR/config.yaml" MC_DB="$MC_DATA/mc.sqlite" MC_PORT="$MC_PORT" \
  node --experimental-strip-types apps/server/src/main.ts
```

In another terminal, confirm the hub and save the token in your password manager. The token stays
on the Mac and is required for write actions:

```sh
curl -s "http://127.0.0.1:$MC_PORT/api/health"
cat "$MC_DATA/operator-token"
```

Open `http://127.0.0.1:$MC_PORT/`. The Sessions page lists the live cmux workspaces.

## 6. Run it under launchd

Create `~/Library/LaunchAgents/$MC_LABEL.plist` with your values in place of the shell variables.
Do not use `~` or `$HOME` inside the plist: launchd does not expand them.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.mission-control.work</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>--experimental-strip-types</string>
    <string>/absolute/path/to/mission-control/apps/server/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/mission-control</string>
  <key>EnvironmentVariables</key><dict>
    <key>MC_CONFIG</key><string>/absolute/path/to/config.yaml</string>
    <key>MC_DB</key><string>/absolute/path/to/mc.sqlite</string>
    <key>MC_PORT</key><string>7431</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/server.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/server.err.log</string>
</dict></plist>
```

Validate and load it:

```sh
plutil -lint "$HOME/Library/LaunchAgents/$MC_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$MC_LABEL.plist"
curl -s "http://127.0.0.1:$MC_PORT/api/health"
```

To stop the service, run `launchctl bootout "gui/$(id -u)/$MC_LABEL"`.

## Check after one hour

Open the Sessions page, token use, checks and FLIGHT. Confirm no seat started and no GitHub write
appeared. The sessions-only configuration has no crew or repository for either action.
