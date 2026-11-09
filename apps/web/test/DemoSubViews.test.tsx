import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { DEMO_REFUSED, setDemo } from "../src/demo/mode.ts";
import { getState, playNext } from "../src/demo/simulator.ts";
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

  it("Flight: status, doing now, blockers and recent decisions on one page", async () => {
    await at("/flight");
    await waitFor(() => {
      for (const name of ["Doing now", "Blockers", "Recent decisions"]) {
        if (!document.body.textContent?.includes(name)) throw new Error(`nothing says ${name}`);
      }
    });
    clean();
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

const play = (beats: number) => {
  getState();
  for (let i = 0; i < beats; i++) playNext();
};

describe("Demo pages keep moving where a person looks", () => {
  it("Comms: the traffic and length panels load, and the graph's counts rise", async () => {
    const before = JSON.stringify(getState().api["/api/comms/links"] as object);
    play(10);
    expect(JSON.stringify(getState().api["/api/comms/links"])).not.toBe(before);
    await at("/comms");
    expect(document.body.textContent).not.toContain("Loading traffic");
    expect(document.body.textContent).not.toContain("Loading message lengths");
    clean();
  });

  it("an Agent page shows activity and tool counts after a few beats", async () => {
    play(10);
    await at("/agent/dev-1");
    expect(document.body.textContent).not.toContain("No activity yet");
    expect(document.body.textContent).not.toMatch(/TOOLS THIS RUN\s*0\b/i);
    expect(document.body.textContent).not.toContain("No build loop is recorded");
    clean();
  });

  it("a ticket in progress has a history", async () => {
    await at("/tickets/shop-app/102");
    expect(document.body.textContent).not.toContain("has not touched this ticket");
    clean();
  });

  it("a PR that appears during the scene has its reads, and the flow lists the open PRs", async () => {
    play(40);
    await at("/qa?repo=shop-app&pr=1101");
    clean();
    document.body.innerHTML = "";
    await at("/map/shop-app?pr=1101");
    clean();
    const flow = getState().api["/api/prs/flow"] as { repos: { rows: { pr: number }[] }[] };
    const prs = (getState().api["/api/repos/shop-app/prs"] as { number: number }[]).map(
      (p) => p.number,
    );
    expect(flow.repos[0]?.rows.map((r) => r.pr).sort()).toEqual([...prs].sort());
  });
});

describe("Demo choices end in data", () => {
  it("Audit: every repository", async () => {
    await at("/audit");
    const select = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLSelectElement>("main select")].find((e) =>
        [...e.options].some((o) => o.value === "site-builder"),
      );
      if (!found) throw new Error("no repo picker");
      return found;
    });
    for (const option of [...select.options]) {
      await act(async () => void fireEvent.change(select, { target: { value: option.value } }));
      await settle();
      clean();
    }
  });

  it("QA history: every repository, and a saved report's link", async () => {
    await at("/qa?view=history");
    const select = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLSelectElement>("main select")].find((e) =>
        [...e.options].some((o) => o.value === "shop-app"),
      );
      if (!found) throw new Error("no repo filter");
      return found;
    });
    expect([...select.options].map((o) => o.value)).not.toContain("mission-control");
    for (const option of [...select.options]) {
      await act(async () => void fireEvent.change(select, { target: { value: option.value } }));
      await settle();
      clean();
    }
    document.body.innerHTML = "";
    await at("/qa?repo=shop-app&pr=1011&history=1");
    clean();
  });
});

describe("Demo findings from round 3", () => {
  it("the Agent page's Queue and Files tabs, and the Setup update log", async () => {
    await at("/agent/dev-1");
    await clickText(/^queue$/i);
    clean();
    await clickText(/^files$/i);
    clean();
    document.body.innerHTML = "";
    await at("/setup");
    await clickText(/update log/i);
    clean();
    expect(document.body.textContent).not.toContain("Could not read update.log");
  });

  it("Comms opens on traffic for the 3 messages beside it, and every seat has contacts", async () => {
    await at("/comms");
    const panel = document.querySelector(".comms-traffic-panel") as HTMLElement;
    expect(document.body.textContent).not.toContain("No messages in FLIGHT");
    expect(panel.textContent).not.toMatch(/\b0\s*msg/);
    const counts = [...document.querySelectorAll(".comms-nav-counts small")].map((e) =>
      Number(e.textContent),
    );
    expect(counts.some((n) => n > 0)).toBe(true);
  });

  it("the seats hold at least four roles and none holds more than four seats", async () => {
    const { rows } = (await import("./overviewDensityFixtures.ts")).demoSeed();
    const roles = new Map<string, number>();
    for (const row of rows) roles.set(row.role ?? "", (roles.get(row.role ?? "") ?? 0) + 1);
    expect(roles.size).toBeGreaterThanOrEqual(4);
    expect(
      Math.max(...[...roles].filter(([r]) => r !== "FLIGHT").map(([, n]) => n)),
    ).toBeLessThanOrEqual(4);
  });

  it("Telemetry draws its charts and fills its tiles", async () => {
    await at("/telemetry");
    const text = document.querySelector("main")?.textContent ?? "";
    expect(text).not.toMatch(/data is not available/);
    expect((text.match(/not tracked yet/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("a ticket that moved shows where it is on every page", async () => {
    play(44);
    await at("/tickets/shop-app/201");
    expect(document.body.textContent).not.toContain("has not touched this ticket");
    expect(document.body.textContent).not.toMatch(/Status\s*Ready/);
    document.body.innerHTML = "";
    await at("/qa");
    expect(document.body.textContent).not.toContain("PR #1107");
    expect(document.body.textContent).toContain("PR #1101");
    document.body.innerHTML = "";
    await at("/");
    expect(document.body.textContent).toMatch(/dev-7.*#201/i);
  });

  it("seats change state and the Step column fills", async () => {
    play(20);
    await at("/");
    const rows = [...document.querySelectorAll("#agentsList .trow:not(.head)")];
    const text = rows.map((r) => r.textContent ?? "");
    expect(text.some((t) => /build|checks|review/i.test(t))).toBe(true);
    const states = new Set(
      (getState().api["/api/crew?shape=summary"] as { rows: { hudState: string }[] }).rows.map(
        (r) => r.hudState,
      ),
    );
    expect(states.size).toBeGreaterThanOrEqual(3);
  });
});

describe("Demo Comms writes", () => {
  it("a refused decision hold says it is a demo", async () => {
    await at("/needs-you");
    await clickText(/^hold$/i);
    const reason = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(".hold-form input[required]");
      if (!found) throw new Error("no hold form");
      return found;
    });
    await act(
      async () => void fireEvent.change(reason, { target: { value: "Waiting for design" } }),
    );
    await act(async () => void fireEvent.submit(reason.closest("form") as HTMLFormElement));
    await settle();
    expect(document.body.textContent).toContain(DEMO_REFUSED);
    expect(document.body.textContent).not.toContain("Could not hold this decision");
  });

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
