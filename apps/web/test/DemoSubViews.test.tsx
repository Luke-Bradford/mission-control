import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { DEMO_REFUSED, setDemo } from "../src/demo/mode.ts";
import { demoMisses } from "../src/demo/source.ts";

/** Beyond each page's first view: every sub-view a person reaches by a click must have its data. */
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  setDemo(true);
});
afterEach(() => vi.unstubAllGlobals());

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 400))));
const at = async (path: string) => {
  window.history.replaceState(null, "", path);
  render(<App />);
  await settle();
};
const clean = () => {
  expect(demoMisses()).toEqual([]);
  expect([...document.querySelectorAll("[role=alert]")].map((e) => e.textContent)).toEqual([]);
};
const clickText = async (name: RegExp) => {
  const target = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role=tab], button, a")].find((e) =>
      name.test(e.textContent ?? ""),
    );
    if (!found) throw new Error(`nothing says ${name}`);
    return found;
  });
  await act(async () => void fireEvent.click(target));
  await settle();
};

describe("Demo sub-views", () => {
  it("QA history", async () => {
    await at("/qa");
    await clickText(/history/i);
    clean();
    expect(document.body.textContent).toMatch(/PR #/);
  });

  it("QA: open a PR's files in the Map", async () => {
    await at("/qa");
    await clickText(/open in map with these files/i);
    clean();
  });

  it.each([/code risk/i, /test health/i, /review quality/i])("Audit tab %s", async (name) => {
    await at("/audit");
    await clickText(name);
    clean();
  });

  it("Flight: what FLIGHT knows", async () => {
    await at("/flight");
    await clickText(/what flight knows/i);
    clean();
    expect(document.body.textContent).toMatch(/checkout cache/i);
  });

  it("Telemetry with a seat filter", async () => {
    await at("/telemetry");
    const select = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLSelectElement>("main select")].find((e) =>
        [...e.options].some((o) => o.value === "dev-1"),
      );
      if (!found) throw new Error("no agent filter");
      return found;
    });
    await act(async () => void fireEvent.change(select, { target: { value: "dev-1" } }));
    await settle();
    clean();
  });

  it("the Map focused on a PR", async () => {
    await at("/map/shop-app?pr=1107");
    clean();
  });

  it("a thread between two seats", async () => {
    await at("/comms/agents/dev-1/contacts/dev-2");
    clean();
  });
});

describe("Demo Flight links", () => {
  it("every same-origin link from the PR flow lands on something that exists", {
    timeout: 60_000,
  }, async () => {
    await at("/flight");
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>("main a[href^='/']")].map(
      (a) => a.getAttribute("href") as string,
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of new Set(hrefs)) {
      document.body.innerHTML = "";
      await at(href);
      expect(demoMisses(), href).toEqual([]);
      expect(document.body.textContent, href).not.toMatch(/is not a ticket|No agent called/);
    }
  });
});

describe("Demo Comms writes", () => {
  it("shows no fault on opening a conversation, and the demo words on a refused write", async () => {
    await at("/comms/crew");
    expect(document.body.textContent).not.toContain("Could not mark this conversation read");
    const ack = await screen.findAllByRole("button", { name: /^ack/i }, { timeout: 4000 });
    await act(async () => void fireEvent.click(ack[0] as HTMLElement));
    await settle();
    expect(document.body.textContent).toContain(DEMO_REFUSED);
    expect(document.body.textContent).not.toContain("Could not add reaction");
  });
});
