# Spike: can a seat see and invoke the repo's skills?

Date: 2026-10-29. Setup: Claude Code 2.1.312, the repo's `.claude/skills/hud-design` present. The
outputs below are the model's answers, quoted as measured on that date (ticket #1051).

**Decision.** Seats could see no skill. The hub now builds a read-only plugin folder from the repo's
`.claude/skills/**` at the run's commit and passes `--plugin-dir <folder>`; `Skill` joins the seat's
built-in tools; `--disable-slash-commands` is dropped. Codex seats get the same skills in
`$CODEX_HOME/skills`.

## Probes

Run each in a checkout that has `.claude/skills/hud-design/SKILL.md`; the prompt asks the model which
skills it can see, or to invoke `hud-design`.

1. Project skills are not loaded under `--restricted`, with or without the `Skill` tool:

   ```
   claude -p "<ask for the skill list>" --restricted
   claude -p "<ask for the skill list>" --restricted --tools Skill
   ```

   Output: "no skill named hud-design appears in my available skills list".

2. `--disable-slash-commands` removes the Skill tool itself (the CLI reference says it disables all
   skills and commands):

   ```
   claude -p "<invoke hud-design>" --restricted --disable-slash-commands --tools Skill
   ```

   Output: "no Skill tool is available".

3. A plugin folder gives the seat the skill. The folder holds `.claude-plugin/plugin.json` and
   `skills/hud-design/SKILL.md`:

   ```
   claude -p "<invoke hud-design>" --restricted --plugin-dir <dir> --tools Skill
   ```

   Output: the model invoked the skill and read it back.

## Why this is safe

A skill is prompt text and cannot widen what a seat may do. The folder is built by the hub from the
verified objects of the run's base commit (never the writable worktree), sits in the hub's data
dir, which the seat cannot write, and carries only `plugin.json` and `skills/`: no hooks, bin or MCP
config. A skill folder holding anything but `SKILL.md` and plain text files (a script, a binary, an
executable or a link) is left out whole (`skillFileProblem` in `packages/core/src/runtime.ts`).
`--restricted`, `--strict-mcp-config` and the guard hook stay.

## Re-running after a CLI upgrade

`node --experimental-strip-types apps/server/test/live/skills-live-check.ts` runs probe 3 with the
hub's own plugin builder and fails if the seat does not invoke `hud-design`. Probes 1 and 2 are the
commands above.

The probe outputs above were measured on 29 Oct (ticket #1051) and copied here; the plugin builder
and refusal rules are covered by `apps/server/test/skills.test.ts`.
