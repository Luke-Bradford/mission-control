import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { DEMO_REFUSED, setDemo } from "../src/demo/mode.ts";
import { demoMisses } from "../src/demo/source.ts";
import { navigate, SETUP_TABS } from "../src/router.ts";

/** Every page in Demo, with the network spied: nothing may leave, nothing may be missing. */
const sources: unknown[] = [];
class StubEventSource {
  constructor() {
    sources.push(this);
  }
  addEventListener() {}
  close() {}
}
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sources.length = 0;
  fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("EventSource", StubEventSource);
  setDemo(true);
});
afterEach(() => vi.unstubAllGlobals());

const PAGES: [string, string, RegExp, string][] = [
  ["Overview", "/", /Recorded|Cache the quote/, "Overview"],
  ["Flight", "/flight", /FLIGHT|Flight/, "Flight"],
  ["Board", "/board", /Cache the quote total/, "Board"],
  ["a ticket", "/tickets/shop-app/101", /Cache the quote total at checkout/, "Board"],
  ["an agent", "/agent/dev-1", /DEV-1/, "Agents"],
  ["a repo's Map", "/map/shop-app", /Crew activity map/i, "Map"],
  ["Comms", "/comms/crew", /Starting on the checkout cache/, "Comms"],
  ["QA", "/qa", /Export orders as CSV/, "QA"],
  ["Telemetry", "/telemetry", /Cycle time/i, "Telemetry"],
  ["Audit", "/audit", /Recommended next actions/, "Audit"],
  ...SETUP_TABS.map((tab): [string, string, RegExp, string] => [
    `Setup ${tab}`,
    `/setup/${tab}`,
    /./,
    "Setup",
  ]),
];

describe("Demo renders every page busy", () => {
  it.each(PAGES)("%s shows the marker, no error and no real request", async (_name, path, text, title) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toMatch(text), { timeout: 4000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(document.querySelector(".demo-marker")?.textContent).toBe("DEMO");
    expect(document.querySelector(".demo-frame")).not.toBeNull();
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(0);
    expect(demoMisses()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sources).toHaveLength(0);
    expect(document.title).toBe(`${title} · DEMO · Mission Control`);
  });

  it("fills the Overview's crew table and the Map's tree", async () => {
    window.history.replaceState(null, "", "/");
    const view = render(<App />);
    await waitFor(() =>
      expect(
        document.querySelectorAll("#agentsList .trow:not(.head)").length,
      ).toBeGreaterThanOrEqual(10),
    );
    view.unmount();
    window.history.replaceState(null, "", "/map/shop-app");
    render(<App />);
    await waitFor(() =>
      expect(document.querySelectorAll(".map-treemap-tile").length).toBeGreaterThanOrEqual(30),
    );
  });

  it("refuses a write from the Away modal and says it is a demo", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /away mode/i }));
    const box = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(".awaypanel .sw input");
      if (!found) throw new Error("not yet");
      return found;
    });
    fireEvent.click(box);
    // a change is only a draft; Save is what sends it, and the demo refuses that
    fireEvent.click(screen.getByRole("button", { name: "Save away mode" }));
    const summary = await screen.findByRole("region", { name: "Away mode was not saved" });
    expect(summary.textContent).toContain(DEMO_REFUSED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops a click on a same-origin /api/ link and says why", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    const link = document.createElement("a");
    link.href = "/api/qa-report-assets/abc";
    link.target = "_blank";
    link.textContent = "evidence";
    document.body.append(link);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(document.getElementById("toast")?.textContent).toBe(DEMO_REFUSED);
    link.remove();
  });

  it("leaves a link to a page alone", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    const link = document.createElement("a");
    link.href = "#board";
    document.body.append(link);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    link.remove();
  });

  it("shows the marker in a popout", async () => {
    window.history.replaceState(null, "", "/agent/dev-1?popout=1");
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".demo-marker-popout")?.textContent).toBe("DEMO"),
    );
    expect(document.title).toBe("dev-1 · DEMO · Mission Control");
  });
});

describe("the header switch", () => {
  it("goes to Demo and back without a reload, with the words the plan names", async () => {
    setDemo(false);
    window.history.replaceState(null, "", "/setup");
    render(<App />);
    const toDemo = await screen.findByRole("button", {
      name: "Switch to Demo: a simulated crew. Nothing is sent to the hub.",
    });
    expect(toDemo.textContent).toBe("Demo");
    expect(document.querySelector(".demo-marker")).toBeNull();
    await act(async () => {
      fireEvent.click(toDemo);
    });
    expect(document.querySelector(".demo-marker")?.textContent).toBe("DEMO");
    expect(document.getElementById("toast")?.textContent).toBe(
      "Demo on: this is a simulated crew.",
    );
    expect(window.location.pathname).toBe("/setup");
    const back = screen.getByRole("button", {
      name: "Switch back to Live: real data from the hub.",
    });
    expect(back.textContent).toBe("Back to Live");
    await act(async () => {
      fireEvent.click(back);
    });
    expect(document.querySelector(".demo-marker")).toBeNull();
    expect(document.title).toMatch(/^(\(\d+\) )?Setup · Mission Control$/);
    expect(document.getElementById("toast")?.textContent).toBe("Back to Live.");
  });

  it("leaves the item, the selection and the session behind on a switch", async () => {
    setDemo(false);
    navigate("/setup");
    render(<App />);
    const toDemo = await screen.findByRole("button", { name: /Switch to Demo/ });
    await act(async () => {
      fireEvent.click(toDemo);
    });
    expect(window.location.pathname).toBe("/setup");
  });
});
