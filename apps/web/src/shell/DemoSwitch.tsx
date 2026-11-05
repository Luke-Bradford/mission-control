import { setDemo, useDemo } from "../demo/mode.ts";
import { navigate, PAGE_PATHS, route, tabOf, usePath, useSearch } from "../router.ts";
import { closeItem } from "./overlays.ts";
import { resetSelection } from "./selection.ts";
import { resetSession } from "./session.ts";
import { toast } from "./Toast.tsx";

const DEMO_ON_TEXT = "Switch to Demo: a simulated crew. Nothing is sent to the hub.";
const DEMO_OFF_TEXT = "Switch back to Live: real data from the hub.";

/**
 * Live or Demo for the whole app. It sits in the footer because the top bar has no spare width
 * at 1280: even an icon button pushed a tab 28 px out of its row (RunTrace.browser.test.ts). A seat or ticket in one world is absent from the other, so the switch also clears what points
 * into the old one and goes to the page's top level.
 */
export function DemoSwitch() {
  const demo = useDemo();
  const path = usePath();
  const search = useSearch();
  const text = demo ? DEMO_OFF_TEXT : DEMO_ON_TEXT;
  return (
    <button
      type="button"
      className={`sm demo-switch${demo ? " on" : ""}`}
      title={text}
      aria-label={text}
      onClick={() => {
        const next = !demo;
        const page = tabOf(route(path, search) ?? { page: "overview" });
        setDemo(next);
        closeItem();
        resetSelection();
        resetSession();
        navigate(PAGE_PATHS[page], { replace: true });
        toast(next ? "Demo on: this is a simulated crew." : "Back to Live.");
      }}
    >
      {demo ? "Back to Live" : "Demo"}
    </button>
  );
}
