# FLIGHT's first prompt: measure it and what it carries

FLIGHT's first call should stay under 100,000 estimated tokens. The hub records each start's sections
(`role`, `rules`, `orders`, `lessons`, `ticket`, `digest`) in `prompt_sections` as wake 0.

## Receipt on a copied database

Never point this at the live database: opening it can migrate it. Copy it first.

```sh
sqlite3 <live db> ".backup <copy>"
node --experimental-strip-types apps/server/src/flight/first-prompt-receipt.ts <copy> flight-1
```

It prints the oldest and the newest recorded start of the seat side by side: each section's estimated
tokens, the totals and an under/over verdict against 100,000. It counts the text Mission Control
sends (the system prompt and the first message), not the provider's own tool list.

## Saved guidance is appended when it changes

A watch seat's message carries the verified direction, the active operator orders and the seat's
instructions in full when:

- nothing has been delivered in this session yet (a new run, including a rotation or handover);
- the instruction revision changed since the last delivery in this session;
- the run was resumed (a hub restart): the session may have lost its history.

Otherwise it carries one line, "Saved guidance unchanged (revision N, direction SHA)", and the message.
A send that fails stores no marker, so the retry is complete. Orders outrank memory either way; a
revoked or replaced order always arrives in the next complete snapshot.
