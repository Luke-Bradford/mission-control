# Run Mission Control on a work Mac

Use this runbook when a Mac only needs Mission Control for its own cmux sessions: the Sessions
page, token use and session checks. It needs no GitHub, repositories, loops or crew. It takes
about 15 minutes.

Mission Control stays on this Mac. The hub listens only on `127.0.0.1`. Session names, terminal
text and transcripts stay local. A sessions-only hub makes no GitHub writes and starts no seats.

FLIGHT is not available on a sessions-only hub yet: it runs as a crew seat, and this hub has no crew.

Every value below (folders, port, launchd label) is your choice. Nothing in Mission Control
expects a particular one.

## 1. Install the tools

Install Node 26 or later and pnpm 11, and check both:

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
Without this, the Sessions page says cmux refuses Mission Control.

## 2. Clone and build

Choose a folder that is not a checkout you edit:

```sh
export MC_HUB_DIR="$HOME/code/mission-control-hub"
git clone https://github.com/Luke-Bradford/mission-control.git "$MC_HUB_DIR"
cd "$MC_HUB_DIR"
pnpm install
pnpm build
```

## 3. Choose the hub's settings

Choose an unused port, a launchd label and private folders for the config, data and logs:

```sh
export MC_PORT=7431
export MC_LABEL=local.mission-control.work
export MC_CONFIG_FILE="$HOME/.config/mission-control/config.yaml"
export MC_DATA="$HOME/.local/share/mission-control"
export MC_LOG_DIR="$HOME/Library/Logs/mission-control"
mkdir -p -m 700 "$MC_DATA" "$MC_LOG_DIR"
```

The hub is started with `MC_LIVE_PORT` set to the same port as `MC_PORT`. Without it, a hub on any
port but the default one treats itself as a preview: it does not write its config and refuses some actions.

## 4. Start once

Start the hub in the foreground. There is no config file yet, so the hub writes a sessions-only
starter config at `$MC_CONFIG_FILE` and comes up on it:

```sh
cd "$MC_HUB_DIR"
MC_CONFIG="$MC_CONFIG_FILE" MC_DB="$MC_DATA/mc.sqlite" MC_PORT="$MC_PORT" MC_LIVE_PORT="$MC_PORT" \
  node --experimental-strip-types apps/server/src/main.ts
```

The first line it prints is `wrote a starter config at <path>`. The file has no accounts,
repositories, loops or crew:

```yaml
operator:
  timezone: "Europe/London"
accounts: []
repos: []
loops: []
poll:
  usage_minutes: 30
  github_seconds: 60
```

Do not add a `crew` section. GitHub is optional: without `gh`, repository and pull-request rows
show none. To add repositories later, sign in with `gh auth login` first, then use Setup › Repos.

In another terminal, check the hub:

```sh
curl -s "http://127.0.0.1:$MC_PORT/api/health"
```

After it starts, the foreground terminal prints `Open Mission Control: http://127.0.0.1:<port>/?bootstrap=…`.
Open that complete URL, not the bare address. The one-time capability signs the page in, then the
page removes it from the address. With no repository the hub opens on the Sessions page, which
lists the live cmux workspaces. Pages that need a repository say so in one line.

At every start the hub writes a new operator token to `$MC_DATA/operator-token`. The browser does
not read that file; only scripts that call the API need it. Stop the hub with Control-C.

## 5. Run it under launchd

Print the values the plist needs:

```sh
echo "node:   $(command -v node)"
echo "hub:    $MC_HUB_DIR"
echo "config: $MC_CONFIG_FILE"
echo "data:   $MC_DATA"
echo "logs:   $MC_LOG_DIR"
echo "port:   $MC_PORT"
echo "label:  $MC_LABEL"
echo "path:   $(dirname "$(command -v node)"):$(dirname "$(command -v cmux)"):/usr/bin:/bin:/usr/sbin:/sbin"
```

If `command -v cmux` prints nothing, put the cmux command on your PATH first (cmux's settings
offer to install it) and print the values again.

Create `~/Library/LaunchAgents/<label>.plist`, replacing every `<...>` with the printed value.
Write full paths: launchd does not expand `~` or `$HOME`. launchd starts the hub with only the
system PATH, so `<path>` is how the hub finds `cmux` and `node`. To show pull requests later, sign
in to `gh` and add the folder of `command -v gh` to the same PATH.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string><label></string>
  <key>ProgramArguments</key><array>
    <string><node></string>
    <string>--experimental-strip-types</string>
    <string><hub>/apps/server/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string><hub></string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string><path></string>
    <key>MC_CONFIG</key><string><config></string>
    <key>MC_DB</key><string><data>/mc.sqlite</string>
    <key>MC_PORT</key><string><port></string>
    <key>MC_LIVE_PORT</key><string><port></string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string><logs>/server.log</string>
  <key>StandardErrorPath</key><string><logs>/server.err.log</string>
</dict></plist>
```

Check and load it:

```sh
plutil -lint "$HOME/Library/LaunchAgents/$MC_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$MC_LABEL.plist"
curl -s "http://127.0.0.1:$MC_PORT/api/health"
open "$(grep -F 'Open Mission Control:' "$MC_LOG_DIR/server.log" | tail -n 1 | sed 's/^Open Mission Control: //')"
```

The last command opens the one-time operator URL written to the service's standard-output log.
Run it after every launchd restart; each start writes a new URL. Do not open the bare hub address.

To stop the service, run `launchctl bootout "gui/$(id -u)/$MC_LABEL"`.

## Check after one hour

Open the Sessions page and its token use and checks. Then confirm the hub did nothing on its own:

- No seat started: the hub has no crew, so the Agents page lists no seat.
- No GitHub write: the hub has no repository to write to. If `gh auth status` says you are not
  signed in, the hub cannot reach GitHub at all.
- It listens only on loopback: `lsof -nP -iTCP:"$MC_PORT" -sTCP:LISTEN` shows `127.0.0.1:<port>`.
