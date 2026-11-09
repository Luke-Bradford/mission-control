# Comms graph observation on PR1675

These artifacts render published application source `4d9938e984cec81c3282318d94bcee603eae187f`. They are controller evidence requested by the ticket, not an independent review or a passing sign-off. The approved prototype is the HTML exported in commit `1c37236f743e95cc7195219ca60f0f4f9da99d18`.

- [Recording beside the prototype](prototype-and-app.webm):14.76seconds,3840x988,25fps. The app uses a controlled10-seat fixture; the prototype uses its historical fixture. They do not show identical data.
- [Actual1920x940 app viewport](graph-1920x940-dark.png).
- [Comparison before new messages](prototype-and-app-before.png) and [after messages/reply](prototype-and-app-after.png).
- [Capture context, CPU measurements, node geometry and limitations](receipt.json).

The rendered application does not meet the visible-seat requirement: its node labels collapse and clip at the upper-left. `CommsRails.tsx` animates `transform` on the same group whose transform places the node, without additive composition. The computed transform replaces its force position with the tiny animation offset. The full-screen chart also omits the prototype's waiting and recent-message lists.

The isolated renderer averages10.30% of one core while idle, above the ticket's under5% target. During20 controlled messages over62.27seconds it averages10.28%; the entire isolated Chrome process tree averages19.16% and peaks35.52% over a one-second interval. These scopes are distinct. The recording and prototype are closed during the CPU measurement. After unmount there are no graph resource requests during31seconds.

Resource updates use the existing browser harness bridge. They exercise rendering without writing to a backend; they do not prove production SSE latency. The controller made no application source changes and did not request an additional review pass. All raw receipts, initial failed instrumentation and original files remain private.
