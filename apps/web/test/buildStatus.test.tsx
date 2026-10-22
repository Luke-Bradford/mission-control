import { DEFAULT_AWAY } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "../src/hud/Panel.tsx";
import { SETUP_TABS } from "../src/router.ts";
import { AwayModal } from "../src/shell/AwayModal.tsx";
import { BUILD_NOTES, BuildChips } from "../src/shell/buildStatus.tsx";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { openAway, openItem, useBuildStatus } from "../src/shell/overlays.ts";
import { BUILD_STATUS_KEY } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

function Toggle() {
  const [on, set] = useBuildStatus();
  return (
    <button type="button" onClick={() => set(!on)}>
      toggle
    </button>
  );
}

const toggle = () => fireEvent.click(screen.getByRole("button", { name: "toggle" }));

describe("BUILD_NOTES", () => {
  it("is the catalogue's table plus the Repos tab: 66 chips with a class, a label and a note", () => {
    expect(BUILD_NOTES).toHaveLength(66);
    for (const n of BUILD_NOTES) {
      expect(["proven", "build", "later", "check"]).toContain(n.cls);
      expect(n.label.length).toBeGreaterThan(0);
      expect(n.note.length).toBeGreaterThan(0);
    }
  });

  it("keys every Setup tab, the Board toolbar, the dock, the Item panel and the Away body", () => {
    const panels = new Set(BUILD_NOTES.map((n) => n.panel));
    for (const tab of SETUP_TABS) expect(panels.has(`setup-${tab}`)).toBe(true);
    for (const id of [
      "boardToolbar",
      "dock",
      "discuss",
      "awayBody",
      "ahead",
      "agentsP",
      "tTotals",
    ]) {
      expect(panels.has(id)).toBe(true);
    }
  });

  it("holds a few rows verbatim", () => {
    expect(BUILD_NOTES).toContainEqual({
      panel: "agentsP",
      cls: "later",
      label: "Loop step: P2",
      note: "The loop-step column needs the loop engine.",
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "quotaP",
      cls: "build",
      label: "Estimates",
      note: '"Full in ~3h" is our projection. Claude figures only update while a Claude agent runs; a richer Claude usage report exists but is marked experimental.',
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "awayBody",
      cls: "check",
      label: "AP on the Mac",
      note: "Proving a test fails on the base commit, the full suite and the reviewer's browser check all need the AP stack running on the Mac.",
    });
  });
});

describe("BUILD_NOTES for the guard, test lock and crew PRs", () => {
  it("say they are live", () => {
    expect(BUILD_NOTES).toContainEqual({
      panel: "actP",
      cls: "later",
      label: "Steps: P2",
      note: "Step and check rows arrive with the loop engine. The current test-lock holder and queue show in the lock box and on Telemetry.",
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "machP",
      cls: "proven",
      label: "Test lock",
      note: "Live: agents' full suites take the test lock one at a time; one in the background is refused with a hint to run it in the foreground, and one still waiting after 10 minutes is refused with a hint to run a single test file.",
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "tLock",
      cls: "build",
      label: "Buildable",
      note: "Lock runs recorded by Mission Control.",
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "setup-roles",
      cls: "proven",
      label: "Proven",
      note: "Guard rules and the test lock are live; the guard drawer on Comms lists each block.",
    });
    expect(BUILD_NOTES).toContainEqual({
      panel: "setup-sessions",
      cls: "proven",
      label: "Proven",
      note: "Sessions and areas are built in P1a, with tests; crew agents each work in their own checkout and commit, push and open draft PRs through Mission Control; stray changes are refused at commit and shown in Needs you.",
    });
  });

  it("leave no note calling them new, not yet built or future", () => {
    const text = BUILD_NOTES.filter((n) =>
      ["actP", "tLock", "setup-roles", "setup-sessions", "machP"].includes(n.panel),
    )
      .map((n) => n.note)
      .join(" ");
    expect(text).not.toMatch(
      /not built yet|is new but|now points|arrive with the test lock|set aside|lock runs shown/,
    );
  });
});

describe("BuildChips", () => {
  it("renders nothing while build status is off", () => {
    const { container } = render(<BuildChips panel="agentsP" />);
    expect(container.textContent).toBe("");
  });

  it("renders a chip per row of the panel, with its note as the tooltip", () => {
    render(
      <>
        <Toggle />
        <BuildChips panel="agentsP" />
      </>,
    );
    toggle();
    const chips = [...document.querySelectorAll(".bs")];
    expect(chips.map((c) => c.textContent)).toEqual(["Proven", "Loop step: P2", "~cost"]);
    expect(chips.map((c) => c.className)).toEqual(["bs bs-proven", "bs bs-later", "bs bs-build"]);
    expect(chips[1]?.getAttribute("title")).toBe("The loop-step column needs the loop engine.");
  });

  it("renders nothing for a panel with no rows", () => {
    render(
      <>
        <Toggle />
        <BuildChips panel="nope" />
      </>,
    );
    toggle();
    expect(document.querySelector(".bs")).toBeNull();
  });

  it("remembers the choice", () => {
    render(<Toggle />);
    toggle();
    expect(localStorage.getItem(BUILD_STATUS_KEY)).toBe("true");
  });
});

describe("Panel and build status", () => {
  it("shows its P2 badge while off; with it on, the badge goes and the chips come", () => {
    render(
      <>
        <Toggle />
        <Panel id="cThreadsP" title="Threads" phase="P2" />
      </>,
    );
    expect(document.querySelector("#cThreadsP .phase")?.textContent).toBe("P2");
    expect(document.querySelector("#cThreadsP .bs")).toBeNull();
    toggle();
    expect(document.querySelector("#cThreadsP .phase")).toBeNull();
    const chip = document.querySelector("#cThreadsP .ph .bs") as HTMLElement;
    expect(chip.textContent).toBe("P2");
    expect(chip.getAttribute("title")).toBe(
      "send_message worked in the spike; threads need the mailbox. @CAPCOM is a prompt convention Mission Control parses.",
    );
    toggle();
    expect(document.querySelector("#cThreadsP .phase")?.textContent).toBe("P2");
  });

  it("leaves the chips to the page for the Agent header", () => {
    render(
      <>
        <Toggle />
        <Panel id="ahead" title="Agent" />
        <Panel title="Conversation" />
      </>,
    );
    act(() => toggle());
    expect(document.querySelector(".bs")).toBeNull();
  });
});

describe("overlays and build status", () => {
  it("the Away modal and the Item panel carry their chips", async () => {
    localStorage.setItem(BUILD_STATUS_KEY, "true");
    stubFetch({
      "/api/attention": [],
      "/api/escalations": [],
      "/api/crew": { rows: [] },
      "/api/config": CONFIG,
      "/api/settings/away": DEFAULT_AWAY,
    });
    render(
      <>
        <AwayModal />
        <ItemPanel />
      </>,
    );
    act(() => {
      openAway();
      openItem("x");
    });
    const away = document.querySelector(".awaypanel") as HTMLElement;
    expect([...away.querySelectorAll(".bs")].map((c) => c.textContent)).toEqual([
      "Buildable",
      "AP on the Mac",
    ]);
    const item = document.querySelector("#discuss") as HTMLElement;
    expect([...item.querySelectorAll(".bs")].map((c) => c.textContent)).toEqual(["P2"]);
    await screen.findByText("This item is no longer open.");
  });
});
