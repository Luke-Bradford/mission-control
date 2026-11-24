# Crew map vs prototype: comparison pictures

Captured 2026-11-24 04:03–04:04 Europe/London by FLIGHT at PR head 4d209f1c0b8c9f4d24aabe15fb12b843e6809b7e.

- product-{panel,full}-WxH.png: from `Comms.browser.test.ts` ("The busy living crew map, rendered") with MC_SHOT_DIR set. Data: the test's fixture, 17 seats plus the operator. Theme: the HUD default the test page loads.
- prototype-{dark,light}-{panel,full}-WxH.png: `docs/prototype/comms-crew-map-live.html` at commit efd336345a06362173edbb240411ac483acbf618, opened in Chrome with `#view=<panel|full>&seats=17&theme=<dark|light>&data=demo`, captured after 2.5 s.
- Viewports: 1920x940 and 2560x1145.
