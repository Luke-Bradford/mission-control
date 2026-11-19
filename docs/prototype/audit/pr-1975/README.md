# PR 1975 review evidence

Rendered by FLIGHT, because the seat's sandbox can't start Chrome. Head: 2ca2b94 (captured 19 Nov 2026, 01:37 UTC). Viewport at scale 1, no page scroll, FLIGHT rail collapsed in both the prototype and the head. The 8e0090d images this replaces are in git history.

| Size | Prototype (unchanged `docs/prototype/audit/audit.html`, dark only) | Head, dark | Head, light |
|---|---|---|---|
| 1920×940 | `prototype-1920x940-dark.png` | `head-2ca2b94-1920x940-dark.png` | `head-2ca2b94-1920x940-light.png` |
| 2560×1145 | `prototype-2560x1145-dark.png` | `head-2ca2b94-2560x1145-dark.png` | `head-2ca2b94-2560x1145-light.png` |
| 1600×1000 | none | `head-2ca2b94-1600x1000-dark.png` | none |

The prototype has only a dark theme, so its dark image pairs with both head themes.

Do next titles, measured in the page at capture: at 1920 and 2560, all 10 collapsed titles fit whole inside their cell, so none needs an ellipsis. At 1600, 9 of the 10 titles are cut with a painted ellipsis (`Reduce review rounds for PR 20…`), and none reaches past its cell. Row 1 is open by default and wraps in full.

Data: the head is served by a preview hub (`MC_NO_LOOP_WRITES=1`) on a copy of the live database. Demo data has only 3 ranked rows, and the done-when asks for at least 5 on the first screen, so live data is used. Data differences, not layout: the head shows 10 ranked rows (the prototype shows 8), all review-round proposals. New outside is empty because outside sources aren't collected yet (the prototype has 10 sample items). The window is 30 days, against 7 in the prototype.

Every other visible difference between the prototype and the head:

| Where | Prototype | Head | Kind, and why it is acceptable |
|---|---|---|---|
| Do next, open row | "If it goes wrong" column | "Ranked and measured" column in its place | Data. The hub stores no failure note for a proposal, so the page shows how the row was ranked rather than inventing one. |
| Do next | "Measure on" date column (2560) | absent | Data. No proposal has a measure date yet ("Review date unset" shows under Decides). |
| Where findings land | "To 28 Oct", "Lines" and "Blocking" columns | absent | Data. The hub stores findings and touches per file, not a dated split, file length or blocking count, so those columns would be empty. |
| What past recommendations achieved | list of changes that landed | "No proposal has been decided yet" | Data. Nothing has been decided, so there is no result to list. |
| How we build, measures | 8 rows with a 7-day vs before comparison | 5 rows, "Previous 30d" mostly "–" | Data. The window is 30 days, and the hub has no record before the first 30. |
| How we build, chart | plot about 104 px tall at 1920×940; legend on the title line | plot about 64 px tall; legend wraps to a second line | Layout. At 1920 the legend wraps under the title and takes height from the plot. It is filed as a minor follow-up, not fixed in this PR. |
| Header and footer | prototype's static nav and footer note | the live app's header and key bar | Shell. The page renders inside the real app. |
