# FLIGHT's first prompt: measure it and what it carries

FLIGHT's first call should stay under 100,000 estimated tokens. The hub records each start's sections
(`role`, `rules`, `orders`, `lessons`, `ticket`, `digest`) in `prompt_sections` as wake 0.

## Receipt on a copied database

Never point this at the live database: opening it can migrate it. Copy it first.

```sh
sqlite3 <live db> ".backup <copy>"
```

```sh
node --experimental-strip-types apps/server/src/flight/first-prompt-receipt.ts <copy> flight-1 \
  [--before <run id or ISO date>] [--after <run id>]
```

It reads every recorded start (wake 0) of the seat, with no limit on later wakes. "Before" is the
oldest start unless you name a run id or an ISO date (the last start before it); "after" is the newest
unless you name a run. It prints each section's estimated tokens, the estimate's total, the context the
provider reported on that run's first reply (read from its transcript) and an under/over verdict against
100,000. The verdict follows the measured figure; a star marks a run with no readable transcript, where
the estimate decides. The estimate counts the text Mission Control sends, not the provider's own tool list.

## Saved guidance is appended when it changes

A watch seat's message carries the verified direction, the active operator orders and the seat's
instructions in full when:

- nothing has been delivered in this session yet (a new run, including a rotation or handover);
- the instruction revision changed since the last delivery in this session;
- the verified direction changed (its sha is part of the marker; a direction.md change on main reaches
  FLIGHT at its next session);
- the session compacted (the compaction count is part of the marker);
- the run was relaunched (any resume or account transfer): the session may have lost its history.

Otherwise it carries one line, "Saved guidance unchanged (revision N, direction SHA)", and the message.
A send that fails stores no marker, so the retry is complete. Orders outrank memory either way; a
revoked or replaced order always arrives in the next complete snapshot.
