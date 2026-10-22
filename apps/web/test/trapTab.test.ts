import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trapTab } from "../src/shell/overlays.ts";

afterEach(() => document.body.replaceChildren());

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function press(root: HTMLElement, shiftKey = false, key = "Tab") {
  const preventDefault = vi.fn();
  trapTab({
    key,
    shiftKey,
    currentTarget: root,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLElement>);
  return preventDefault;
}

const focus = (root: HTMLElement, sel: string) => (root.querySelector(sel) as HTMLElement).focus();
const active = () => document.activeElement?.id;

describe("trapTab", () => {
  it("wraps from the last enabled button when the real last one is disabled", () => {
    const root = mount(
      `<button id="a"></button><button id="b"></button><button id="c" disabled></button>`,
    );
    focus(root, "#b");
    expect(press(root)).toHaveBeenCalled();
    expect(active()).toBe("a");
  });

  it("skips tabindex -1, hidden, inside [hidden] and input[type=hidden]", () => {
    const root = mount(
      `<button id="a"></button><button id="b"></button>
       <button id="c" tabindex="-1"></button><button id="d" hidden></button>
       <div hidden><button id="e"></button></div><input id="f" type="hidden">`,
    );
    focus(root, "#b");
    press(root);
    expect(active()).toBe("a");
    press(root, true);
    expect(active()).toBe("b");
  });

  it("counts summary and contenteditable as stops", () => {
    const root = mount(
      `<button id="a"></button><details><summary id="s">x</summary></details><div id="ce" contenteditable="true" tabindex="0"></div>`,
    );
    focus(root, "#a");
    press(root, true);
    expect(active()).toBe("ce");
    press(root);
    expect(active()).toBe("a");
  });

  it("treats focus outside the stops (the root itself, or elsewhere) as an edge", () => {
    const root = mount(`<button id="a"></button><button id="b"></button>`);
    root.tabIndex = -1;
    root.focus();
    press(root);
    expect(active()).toBe("a");
    root.focus();
    press(root, true);
    expect(active()).toBe("b");
  });

  it("ignores keys other than Tab", () => {
    const root = mount(`<button id="a"></button>`);
    expect(press(root, false, "x")).not.toHaveBeenCalled();
  });
});
