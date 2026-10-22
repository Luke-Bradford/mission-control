# Spike: Agent SDK on the Claude Max subscription

Date: 2026-10-17. Decision: **`CTO_RUNTIME = "cli-headless"`**.

## Command

```
cd spikes/agent-sdk-subscription && npm install --no-package-lock @anthropic-ai/claude-agent-sdk   # ^0.3.302
env -u ANTHROPIC_API_KEY node run.mjs    # one query(), prompt "Reply with the word ok.", maxTurns: 1
```

`ANTHROPIC_API_KEY` was unset in the shell as well. No credentials were read or recorded; the macOS Keychain was not touched. Per controller ruling the 20-turn run and the before/after utilisation check (brief Step 3) were not done.

## Evidence

`system/init` (trimmed to the auth-relevant fields): `apiKeySource: "none"`, `model: "claude-opus-5-5"`. No other auth, plan or billing field is present.

`result` (two runs): `is_error: false`, `result: "ok"`, `num_turns: 1`, `total_cost_usd` 0.3516 (first run) and 0.1544 (second). Each model's `modelUsage` entry has `costBasis: "list"`, `provider: "firstParty"`.

SDK type docs, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` line 133 (`ApiKeySource`):

> 'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or a third-party cloud provider).

`sdk.d.ts` line 1485-1487 (`costBasis`): "Which price table the most recent request for this model was priced at: Claude Code's built-in list prices ('list'), the organization's managed-settings modelPricing rates..."

The package README has no text about subscription, OAuth or `ANTHROPIC_API_KEY` auth; it only links to the online docs.

## Reading

- The SDK authenticated with no API key. `apiKeySource: "none"` is consistent with the claude.ai OAuth login, but the docs list it equally for a bearer token or a cloud provider, so it does not prove which.
- `total_cost_usd` is a list-price estimate (`costBasis: "list"`), so a non-zero value does not mean API billing and a zero would not have meant subscription. It is not evidence either way.
- Nothing recorded shows that usage landed on the subscription's 5h/7d windows. That check (before and after utilisation) was not run.

## Decision

The rule requires **both** authentication without an API key **and** usage landing on the subscription. The first holds; the second is unverified, so the evidence is ambiguous. Safe default: `cli-headless` (the CTO runs as headless `claude -p` iterations like the existing loops, with the Control Centre MCP server attached). Revisit `agent-sdk` once the OAuth usage endpoint (Task 2) exists and a before/after utilisation check can be run.
