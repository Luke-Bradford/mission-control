# Plan: push check records

1. Reproduce a Codex command completion recording the configured `lint && typecheck` pair on its clean HEAD.
2. Keep the commit captured when the call starts, and make completion identity resilient to Codex approval/item identifiers.
3. Keep the push gate fail-closed, but describe the newest record for each refused command, including its commit and result.
4. Permit an evidence report to retry an unchanged push refusal, then run the affected checks and project validation.
