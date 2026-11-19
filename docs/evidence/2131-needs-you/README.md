# PR 2131: Needs you before and after

Stage 6a removes two Needs-you item kinds: crew strays and crew errors. These pictures show that the
rest of the page is unchanged.

- Before: main at 271bba8. After: PR head bcdff6d.
- Both ran as preview servers (`MC_NO_LOOP_WRITES=1`, `MC_NO_CREW=1`) on one copy of the live
  database, taken at 23:19 on 19 November 2026. That copy holds 0 strays and 0 crew errors, so a
  normal day shows the same page before and after.
- Each page was opened from Overview by clicking Needs you. Sizes are 1920×940 and 2560×1145, in
  dark and light, with headless Chromium 1234 through playwright-core 1.58.2.
- Row-by-row pixel comparison of each pair: only rows 19 to 30 differ, which is the header clock
  (23:23 and 23:24). Every other row is identical.
