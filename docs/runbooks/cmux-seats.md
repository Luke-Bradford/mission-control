# Claude seats in cmux

Each Claude seat runs in its own cmux workspace. Open cmux to watch its work, type a reply, or use `/clear` to start a fresh Claude conversation in the same workspace.

Mission Control reads the workspace state. A seat marked Waiting says `Needs your input in cmux`; cmux rings for a completed turn and for a permission request.

Before starting a seat, allow local automation in `~/.config/cmux/cmux.json`:

```json
{ "automation": { "socketControlMode": "automation" } }
```

This is local Mac configuration. The workspace starts Claude with Mission Control's settings and MCP configuration, rather than personal plugins.
