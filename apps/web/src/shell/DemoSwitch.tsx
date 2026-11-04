import { setDemo, useDemo } from "../demo/mode.ts";
import { navigate, PAGE_PATHS, route, tabOf, usePath, useSearch } from "../router.ts";
import { closeItem } from "./overlays.ts";
import { resetSelection } from "./selection.ts";
import { resetSession } from "./session.ts";
import { toast } from "./Toast.tsx";

const DEMO_ON_TEXT = "Switch to Demo: a simulated crew. Nothing is sent to the hub.";
const DEMO_OFF_TEXT = "Switch back to Live: real data from the hub.";

/**
 * Live or Demo for the whole app, an icon button in the top bar (a text button leaves no spare
 * width at 1280). A seat or ticket in one world is absent from the other, so the switch also clears what points
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
      className={`ghost iconbtn demo-switch${demo ? " on" : ""}`}
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
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {demo ? (
          <path
            d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M3 3h10v10H3zM6.5 5.5v5l4-2.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}
