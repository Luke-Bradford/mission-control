// The harness's first import: it runs before the app reads its mode. `?demo=1` is the tab's Demo
// choice, set the way the header switch sets it, so a test boots straight into Demo.
import { DEMO_KEY } from "../src/storage.ts";

if (new URLSearchParams(location.search).get("demo") === "1")
  sessionStorage.setItem(DEMO_KEY, "true");
