# #1624 evidence: the shared FLIGHT thread on Needs you

Captured from `apps/web/test/NeedsPage.browser.test.ts` with `MC_SHOT_DIR` set, at source head
`aace2523431a9442b5c1385257d61948772af63d`, fixture data from that test (fictional repos and messages).

Files are `needs-<page|flyout>-<width>x<height>-<light|dark>-<state>.png` at 1280, 1600 and 1920 wide:

1. `open`: the question with the thread beside it (`About: <title>`, `Message FLIGHT`).
2. `reply`: a message sent beside the question and FLIGHT's reply, the same on page and fly-out.
3. `picked`: an option picked, exactly one `You chose` receipt, and the question gone from Waiting on you.

The test asserts each state before it captures it; 9 of 9 tests passed on that head.
