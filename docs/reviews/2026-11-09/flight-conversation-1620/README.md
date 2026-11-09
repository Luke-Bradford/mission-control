# Joined FLIGHT conversation: consumer compatibility

Source: `3975c9adbf5a70a4db0504fbd12ca6d94e67d0c5`.
Baseline: deployed main `03ef6b5212e0fff0193f20e6bff3d226eabca2c7`.

Eight matched pairs use the same production Comms browser harness and synthetic API fixture:
1280×1000, 1600×1000, 1920×1000 and 1600×700, each in light and dark.
The fixture contains operator text, stored FLIGHT text, dated and undated transcript text,
and a durable choice receipt. The images show the consumer of the joined source. They do not
claim the old server returned transcript lines: the actual server join is covered separately
by `apps/server/test/flight-conversation.test.ts`.

The unchanged baseline renders an undated turn as 1 Jan 01:00. The source renders — and omits
stored-only Reply, Ack, Pin and reaction controls on transcript identities. The normal stored
message controls and the existing conversation layout remain. These images are evidence for
this small compatibility change, not the shared-thread redesign in #1621 or #1624.

`manifest.json` records the exact source trees and image SHA-256 hashes. The baseline capture
uses the same fixture with only three assertions for the new behavior removed from its capture
driver. No production baseline source was modified. Its successful capture is not a claim
that baseline passes the new functional requirements. Current source passes all four browser
cases, rendering eight viewport/theme combinations with order, time and control assertions.

These are local fixtures, not live-data screenshots or an independent QA verdict. The normal
fresh review and CI gates still apply. Source was not edited during its full test run.
