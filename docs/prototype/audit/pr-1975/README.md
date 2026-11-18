# PR 1975 review evidence

Rendered by FLIGHT, because the seat's sandbox can't start Chrome. Head: 8e0090d. Viewport at scale 1, no page scroll, FLIGHT rail collapsed in both the prototype and the head.

| Size | Prototype (unchanged `docs/prototype/audit/audit.html`, dark only) | Head, dark | Head, light |
|---|---|---|---|
| 1920×940 | `prototype-1920x940-dark.png` | `head-8e0090d-1920x940-dark.png` | `head-8e0090d-1920x940-light.png` |
| 2560×1145 | `prototype-2560x1145-dark.png` | `head-8e0090d-2560x1145-dark.png` | `head-8e0090d-2560x1145-light.png` |

The prototype has only a dark theme, so its dark image pairs with both head themes.

Data: the head is served by a preview hub (`MC_NO_LOOP_WRITES=1`) on a copy of the live database. Demo data has only 3 ranked rows, and the done-when asks for at least 5 on the first screen, so live data is used. Data differences, not layout: the head shows 10 ranked rows (the prototype shows 8), all review-round proposals. New outside is empty because outside sources aren't collected yet (the prototype has 10 sample items). The window is 30 days, against 7 in the prototype.
