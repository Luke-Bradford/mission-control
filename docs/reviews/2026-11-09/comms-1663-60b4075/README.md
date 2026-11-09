# Comms graph: observation after placement correction

This packet renders published PR1675 source `60b407503b1896a3ff0ecc1bb1df69bf6c8496ef`. The prior capture of4d9938e is retained in evidence commit `a0bfb2aadd1a7310ad5e30d9f3f1ef23301aa3ef`. This is required controller evidence, not another independent QA pass.

- [Recording beside the approved prototype](prototype-and-app.webm).
- [Actual1920x940 app](graph-1920x940-dark.png), [comparison before messages](side-by-side-before.png), [after messages/reply](side-by-side-after.png).
- [Capture context, CPU scopes, geometry and limitations](receipt.json).

The placement correction works: nodes no longer collapse at the upper-left. The layout still overlaps the SEAT1 and SEAT3 names in the controlled ten-seat case, and the full chart still lacks the waiting and recent-message lists.

Idle renderer CPU is6.338% over31.08seconds, above the under5% target. During20 messages over62.13seconds the renderer averages8.675% and the entire isolated Chrome tree12.152%. The recording and prototype are closed duringCPU measurement. After unmount there are no graph resource requests during30.85seconds.

The controlled fixture simulates topic refreshes using the existing browser harness; this does not establish production SSE latency. The prototype has its own historical fixture. No production source or native branch was edited by the controller.
