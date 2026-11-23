# PR 2148: the Audit page beside the approved prototype

- Head: 37a48a0 (`head-37a48a0-*.png`). Prototype: the approved `docs/prototype/audit/audit.html`, unchanged
  (`prototype-*.png`). The prototype has a dark theme only, so it is shown once per size.
- Data: a copy of the live database taken at 23:21 on 22 November 2026, served by a preview hub on port 7488
  with `MC_NO_LOOP_WRITES=1` and `MC_NO_CREW=1`. Range 30d.
- Sizes 1920×940 and 2560×1145, dark and light, headless Chromium 1234 through playwright-core 1.58.2.
- Speed on the same preview: `GET /api/audit?range=30d` answered in 0.002 to 0.021 s (cold after start and
  repeated), against the under-1 s Done-when.

SHA-256:

| Image | Hash |
| --- | --- |
| head-37a48a0-1920x940-dark.png | c2855515c1a45a77fd99a8c5403dd90135005e4edbd5d3c1109bc0e65ef87037 |
| head-37a48a0-1920x940-light.png | 2b724b8ff9ff93bf87d837c4f35669cdfebeeb84256a8baf01fc1f62799fb34a |
| head-37a48a0-2560x1145-dark.png | 7ca25b284fedfbee17815c594cb765928312bc086786fc2a6e2ca8d2d4b7b591 |
| head-37a48a0-2560x1145-light.png | ddaa2f6b57ff149748d6fd21e4d0ab1c27aba1d4c01185fbbfdba1824df739f8 |
| prototype-1920x940.png | 734cac9c92bdd51f61d815ebef7c358837b38781ec20cbd4f24046bd8f20fbc3 |
| prototype-2560x1145.png | 47eb080da6d19f6f9ded6b3b3030ac867fde08f6b7cd0a30e66d513ceb32cc3f |
