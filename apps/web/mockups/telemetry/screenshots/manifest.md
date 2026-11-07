# Screenshot manifest

Status: none captured yet.

Reason: the building seat's sandbox cannot launch Chrome, so nothing was rendered by the author. CI renders the mockup in `TelemetryMockup.browser.test.ts`.

To capture, with a browser available and the fictional data as shipped:

| Image | Source | Size | Theme |
| --- | --- | --- | --- |
| Each tab | `index.html?tab=<tab>` | 1280x900, 1600x1000, 1920x940 | dark and light |
| Each tab | `index.html?tab=<tab>` | 2560x1145 | dark |
| Each state | `index.html?state=<state>` | 1600x1000 | dark |
| Today's page, fixture data | `apps/web/test/desktopBrowser.html` at c2bea393 | 1280, 1600, 1920 wide | dark |

Record for each: PR, head, source file, baseline, capture time, image hash, CSS size, device scale, zoom, theme, rail (48 px), browser and OS, fixture, clock, scroll, and whether it is a viewport, full-page or crop capture.
