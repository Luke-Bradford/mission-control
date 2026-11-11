# Seat prompt and comms_inbox receipt (#1645)

What changed, and what it measured before and after. Synthetic and repository text only; no real Comms message is quoted.

## Seat prompt

`rolePrompt` (`apps/server/src/runtime/brief.ts`) drops the fenced yaml block that opens with `mc:` from the repo's CLAUDE.md. The hub still reads that block from the repo itself. Everything else stays: source of truth, repo rules, review, skills, checks, and the prose above the block.

| Text | Before | After |
| --- | --- | --- |
| This repo's CLAUDE.md in the prompt | 5,985 bytes | 4,518 bytes |

That is 1,467 bytes (about 370 tokens at 4 bytes a token) per seat start. The ticket's 560-token figure is the baseline's own estimate; the byte count above is the measured value.

Test: `apps/server/test/brief.test.ts`, "omits only the hub-only Mission Control YAML block".

## comms_inbox

The default is now the unread messages plus current pins; `all: true` returns the read history as before. The result gains `hiddenRead`, the count of read messages left out. Read receipts, the privacy filter (`canReadComms`) and ordering are unchanged, and ids are the same in both views.

Compatibility: a caller that sends `{ limit }` still gets the same shape; `messages` holds fewer rows once messages have been read. A caller that wants the old behaviour passes `all: true`.

Receipt (synthetic: 49 read messages of about 200 characters beside one new message):

| Call | Returned |
| --- | --- |
| `all: true` (old behaviour) | 23,010 bytes |
| default | 284 bytes |

Test: `apps/server/test/mcp-tools.test.ts`, "inbox defaults to unread messages plus pins".

The seven-day production measurement is tracked under #1431's Controller check and starts from this change's deployment.
