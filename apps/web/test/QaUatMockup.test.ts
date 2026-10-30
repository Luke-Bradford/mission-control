import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const mockup = readFileSync(join(import.meta.dirname, "../mockups/qa-uat/index.html"), "utf8");
const doms: JSDOM[] = [];
const typeInto = (field: HTMLTextAreaElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new (doms[0]?.window ?? window).Event("input"));
};

const renderMockup = (search = "", html = mockup) => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: `http://localhost/qa-uat${search}`,
  });
  doms.push(dom);
  return dom.window.document;
};

afterEach(() => {
  doms.splice(0).forEach((dom) => {
    dom.window.close();
  });
});

const visibleStatePanel = (document: Document, state: string) =>
  document.body.getAttribute("data-state") === state;

describe("QA UAT mockup", () => {
  it("lists what waits for the operator oldest first, above the PRs in review", () => {
    const document = renderMockup();
    const headings = [...document.querySelectorAll(".qh h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Waiting for you", "Also in review"]);
    const ages = [...document.querySelectorAll("#uat .qrow")].map((row) =>
      Number(row.getAttribute("data-age-hours")),
    );
    expect(ages).toHaveLength(3);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
    expect(document.querySelector("#uat .age")?.textContent).toBe("2d 3h");
  });

  it("has every section the operator needs to decide", () => {
    const document = renderMockup();
    const panels = [...document.querySelectorAll("#detail .ph h2")].map((h) => h.textContent);
    expect(panels).toEqual([
      "Before and after",
      "Tests run",
      "Rework",
      "Impact",
      "Try it",
      "Related Comms",
      "Ask QA",
    ]);
    const buttons = [...document.querySelectorAll(".dhead .actions button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(["Accept", "Send back…"]);
    expect(document.querySelector("#q")).not.toBeNull();
    expect(document.body.textContent).toContain("Open in Map, focused on these 5 files");
  });

  it.each(["queue", "nocapture", "loading", "empty", "error", "stale", "disconnected"])(
    "opens in the %s state from the query",
    (state) => {
      const document = renderMockup(`?state=${state}`);
      expect(visibleStatePanel(document, state)).toBe(true);
      expect(
        document.querySelector(`#states [data-state="${state}"]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it("words each failure state, and hides the detail when the queue cannot load", () => {
    const text = (state: string) => {
      const document = renderMockup(`?state=${state}`);
      const detail = document.querySelector<HTMLElement>("#detail section.panel");
      return { body: document.body.textContent ?? "", hidden: detail?.style.display === "none" };
    };
    expect(text("error")).toMatchObject({ hidden: true });
    expect(text("error").body).toContain("The queue did not load");
    expect(text("stale").body).toContain("9 minutes ago");
    expect(text("stale").hidden).toBe(false);
    expect(text("disconnected").body).toContain("Lost the connection to the hub");
    expect(text("loading").hidden).toBe(true);
    expect(text("empty").body).toContain("Nothing is waiting for you");
    expect(text("nocapture").body).toContain("evidence not captured");
  });

  it("turns off Accept, Send back and Ask QA only when disconnected", () => {
    const off = (state: string) => {
      const document = renderMockup(`?state=${state}`);
      return [...document.querySelectorAll<HTMLButtonElement>(".dhead .actions button")].map(
        (b) => b.disabled,
      );
    };
    expect(off("disconnected")).toEqual([true, true]);
    expect(off("queue")).toEqual([false, false]);
  });

  it("switches state and theme from the mockup controls", () => {
    const document = renderMockup("?theme=light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    document.querySelector<HTMLButtonElement>('#themes [data-theme="dark"]')?.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.querySelector<HTMLButtonElement>('#states [data-state="error"]')?.click();
    expect(document.body.getAttribute("data-state")).toBe("error");
    expect(document.querySelector("#qcount")?.textContent).toBe("Could not load");
  });

  it("asks for a note before Send back can be sent, and returns focus on cancel", () => {
    const document = renderMockup();
    const open = document.querySelector<HTMLButtonElement>("#sendbtn");
    const form = document.querySelector("#sendback");
    const send = document.querySelector<HTMLButtonElement>("#sendback .send");
    const note = document.querySelector<HTMLTextAreaElement>("#note");
    if (!open || !form || !send || !note) throw new Error("send-back controls missing");
    expect(form.classList.contains("open")).toBe(false);
    expect(send.disabled).toBe(true);
    open.click();
    expect(form.classList.contains("open")).toBe(true);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(note);
    typeInto(note, "   ");
    expect(send.disabled).toBe(true);
    typeInto(note, "Interrupt overlaps Answer at 1366.");
    expect(send.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>("#cancel")?.click();
    expect(form.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(open);
  });

  it("opens Send back from the query", () => {
    const document = renderMockup("?sendback=1");
    expect(document.querySelector("#sendback")?.classList.contains("open")).toBe(true);
  });

  it("keeps to the spacing tokens", () => {
    expect(mockup).not.toMatch(/gap:\s*\d+px/);
    const raw = [...mockup.matchAll(/(?:padding|margin|gap):\s*([^;}]+)/g)]
      .flatMap((m) => m[1]?.split(/\s+/) ?? [])
      .filter((v) => /^\d+px$/.test(v));
    expect(raw).toEqual([]);
  });

  describe("fixtures", () => {
    const queueRow = (i: number, title: string) =>
      `<li><a class="qrow" data-age-hours="${i}" href="#"><span class="t">${title}</span><span class="age">${i}h</span><span class="m">#${i}</span></a></li>`;
    const withRows = (rows: string[]) =>
      mockup.replace(
        /(<ul class="qlist" aria-label="Pull requests in UAT[^>]*>)[\s\S]*?(<\/ul>)/,
        `$1${rows.join("")}$2`,
      );

    it("renders one waiting PR", () => {
      const document = renderMockup("", withRows([queueRow(5, "Only one")]));
      expect(document.querySelectorAll("#uat .qrow")).toHaveLength(1);
    });

    it("renders 50 waiting PRs inside a list that scrolls rather than clips", () => {
      const rows = Array.from({ length: 50 }, (_, i) => queueRow(50 - i, `PR ${i}`));
      const document = renderMockup("", withRows(rows));
      expect(document.querySelectorAll("#uat .qrow")).toHaveLength(50);
      expect(mockup).toMatch(/\.qlist\{max-height:[^;]+;overflow:auto/);
    });

    it("clamps a very long title to two lines instead of clipping it", () => {
      const title = "x".repeat(400);
      const document = renderMockup("", withRows([queueRow(5, title)]));
      expect(document.querySelector("#uat .t")?.textContent).toHaveLength(400);
      expect(mockup).toMatch(/\.qrow \.t\{[^}]*-webkit-line-clamp:2/);
    });
  });
});
