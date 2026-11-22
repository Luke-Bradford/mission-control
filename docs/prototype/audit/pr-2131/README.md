# PR 2131: Needs you before and after

Stage 6a removes two kinds of Needs-you item: crew strays and crew errors. These pictures show what
that does to the page.

- Before: main at 271bba8. After: PR head 1e93dc8 (the code is the same as bcdff6d; 1e93dc8 only
  added an evidence note).
- Fixture: one copy of the live database, taken at 23:55 on 19 November 2026, with one stray
  (`fixture-stray-1`, kind other-area) and one unacked crew error added. Both previews ran on that
  same fixture with `MC_NO_LOOP_WRITES=1` and `MC_NO_CREW=1`.
- Each page was opened from Overview by clicking Needs you. Sizes are 1920×940 and 2560×1145, in
  dark and light, with headless Chromium 1234 through playwright-core 1.58.2.
- The fixture had no open question, so these pictures also show the empty state.
- Result: main already shows neither the stray nor the crew error on this page. Row-by-row pixel
  comparison: the 2560×1145 pairs are byte-identical, and the 1920×940 pairs differ only in rows 19
  to 29, the header clock (23:57 and 23:58).
- Earlier pairs on live data with one open question showed the same: only the clock differed.

SHA-256 (first 16 characters):

| Image | Hash |
| --- | --- |
| main-271bba8-1920x940-dark.png | 8478880f2d327c9b |
| head-1e93dc8-1920x940-dark.png | 4939bd80c75d71d9 |
| main-271bba8-1920x940-light.png | abffcc8468a3a5da |
| head-1e93dc8-1920x940-light.png | ce3a7c31daacae5e |
| main-271bba8-2560x1145-dark.png | b4f95c98a171dbbd |
| head-1e93dc8-2560x1145-dark.png | b4f95c98a171dbbd |
| main-271bba8-2560x1145-light.png | b26a40ec80f4bba9 |
| head-1e93dc8-2560x1145-light.png | b26a40ec80f4bba9 |
