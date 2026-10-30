import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const mockup = readFileSync(join(import.meta.dirname, "../mockups/overview/index.html"), "utf8");
const doms: JSDOM[] = [];

const renderMockup = () => {
  const dom = new JSDOM(mockup, { runScripts: "dangerously", url: "http://localhost/overview" });
  doms.push(dom);
  return dom.window.document;
};

afterEach(() => doms.splice(0).forEach((dom) => dom.window.close()));

describe("Overview v2 mockup", () => {
  it("keeps the desktop pipeline tall enough for its Board controls", () => {
    expect(mockup).toContain("grid-template-rows:62px 458px 160px minmax(0,1fr)");
  });

  it("has one accurate filtered Board link for every populated pipeline stage", () => {
    const document = renderMockup();
    const stages = [...document.querySelectorAll(".pipeline .stage")];

    expect(stages.map((stage) => stage.querySelector(".more")?.getAttribute("href") ?? null)).toEqual([
      "/board?stage=ready",
      "/board?stage=progress",
      null,
      "/board?stage=merged",
    ]);
    expect(stages.map((stage) => stage.querySelector(".more")?.textContent ?? null)).toEqual([
      "+4 · open Board ›",
      "+6 · open Board ›",
      null,
      "+3 · open Board ›",
    ]);
  });

  it("updates the theme action name and opens a focusable log detail panel", () => {
    const document = renderMockup();
    const theme = document.querySelector<HTMLButtonElement>(".theme");
    const logLink = document.querySelector<HTMLAnchorElement>(".why");
    const detail = document.querySelector<HTMLElement>("#log-detail");

    expect(theme).not.toBeNull();
    expect(logLink).not.toBeNull();
    expect(detail).not.toBeNull();
    theme!.click();
    expect(theme!.getAttribute("aria-label")).toBe("Toggle dark theme");
    logLink!.click();
    expect(detail!.hidden).toBe(false);
    expect(document.activeElement).toBe(detail!.querySelector("button"));
  });
});
