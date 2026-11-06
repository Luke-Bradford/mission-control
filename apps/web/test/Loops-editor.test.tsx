import { RETRY_NOTE } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Loops } from "../src/setup/Loops.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { TEMPLATES as list } from "./templateFixtures.ts";

const profiles = { source: "built-in", version: "a".repeat(64), error: null, list };
const config = { ...CONFIG, profiles };
beforeEach(() => stubFetch({ "/api/crew?shape=summary": { rows: [], firstRunToday: null } }));
afterEach(cleanup);

it("renders all seven catalogue descriptions, checks, gates, retries and budgets", () => {
  render(<Loops config={config} />);
  expect(list).toHaveLength(7);
  for (const p of list) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${p.name} ·`) }));
    const panel = screen.getByRole("region", { name: p.name });
    expect(panel.textContent).toContain(`runs for: ${p.trigger}`);
    expect(panel.textContent).toContain(
      `Up to ${p.rounds === 1 ? "1 round" : `${p.rounds || "∞"} rounds`}`,
    );
    expect(panel.textContent).toContain(
      `Token budget ${p.budget == null ? "—" : `${p.budget / 1000}k`}`,
    );
    expect(panel.textContent).toContain(RETRY_NOTE);
    expect(
      Array.from(panel.querySelectorAll(".pcard > b"))
        .slice(0, p.steps.length)
        .map((el) => el.textContent),
    ).toEqual(p.steps.map((step, i) => `${i + 1} · ${step.name}`));
    for (const s of p.nodes ?? p.steps) {
      expect(panel.textContent).toContain(s.role);
      for (const c of s.checks ?? []) {
        expect(panel.textContent).toContain(c.text);
        expect(within(panel).getAllByText(c.kind).length).toBeGreaterThan(0);
      }
      if (s.retry) expect(panel.textContent).toContain(`↻ ${s.retry}`);
      if (s.max) expect(panel.textContent).toContain(`Up to ${s.max} tries.`);
    }
  }
  fireEvent.click(screen.getByRole("button", { name: /^feature ·/ }));
  expect(screen.getByText("2 · go/no-go").parentElement?.className).toContain("gate");
  expect(
    screen.getByText(
      "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence.",
    ),
  ).toBeTruthy();
});

function open() {
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  return screen.getByRole("form", { name: "New template" });
}
function fill(form: HTMLElement) {
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "sample-work" } });
  fireEvent.change(within(form).getByLabelText("Trigger label"), { target: { value: "sample" } });
  fireEvent.change(within(form).getByLabelText("Check 1 text"), {
    target: { value: "Scoped tests pass" },
  });
}
it("validates before writes and cancel makes no write", () => {
  const fetch = stubFetch({});
  render(<Loops config={config} />);
  const form = open();
  fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
  expect(within(form).getByRole("link", { name: /^Name must be lowercase/ })).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form")).toBeNull();
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("a step error links to and focuses its field", () => {
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.change(within(form).getByLabelText("Step name"), { target: { value: "" } });
  fireEvent.change(within(form).getByLabelText("Check 1 text"), { target: { value: " " } });
  fireEvent.submit(form);
  const summary = within(form).getByRole("region", { name: "Fix before saving" });
  expect(document.activeElement).toBe(summary);
  fireEvent.click(within(summary).getByRole("link", { name: /^Step 1: a name of up to 100/ }));
  const step = within(form).getByLabelText("Step name");
  expect(document.activeElement).toBe(step);
  expect(step.getAttribute("aria-invalid")).toBe("true");
  expect(step.getAttribute("aria-describedby")).toBe(`${step.id}-error`);
  fireEvent.click(within(summary).getByRole("link", { name: /^Step 1, check 1: text/ }));
  expect(document.activeElement).toBe(within(form).getByLabelText("Check 1 text"));
  // typing the fix clears the error without another submit
  fireEvent.change(within(form).getByLabelText("Step name"), { target: { value: "implement" } });
  expect(within(summary).queryByRole("link", { name: /^Step 1: a name/ })).toBeNull();
});
it("saves a checked label template and selects the saved result", async () => {
  let body:
    | { base: string; profile: { labels: string[]; steps: { checks: unknown[] }[] } }
    | undefined;
  const saved = { ...list[0], name: "sample-work", trigger: "label sample" };
  stubFetch({
    "POST /api/profiles": (init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return { status: 201, body: { ...profiles, list: [...list, saved] } };
    },
  });
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.submit(form);
  await screen.findByRole("region", { name: "sample-work" });
  expect(body?.base).toBe(profiles.version);
  expect(body?.profile.labels).toEqual(["sample"]);
  expect(body?.profile.steps[0]?.checks).toEqual([{ kind: "cmd", text: "Scoped tests pass" }]);
  expect(screen.queryByRole("form")).toBeNull();
});
it.each([
  "step names must be unique",
  "template already exists",
  "profiles changed; reload and retry",
])("preserves drafts after %s", async (error) => {
  stubFetch({ "POST /api/profiles": () => ({ status: 409, body: { error } }) });
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.submit(form);
  await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain(error));
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("sample-work");
  expect(within(form).getByRole("button", { name: "Refresh templates" })).toBeTruthy();
});

it("focuses the editor, supports Escape, and returns focus to New", () => {
  render(<Loops config={config} />);
  const form = open();
  expect(document.activeElement).toBe(within(form).getByLabelText("Name"));
  fireEvent.keyDown(within(form).getByLabelText("Name"), { key: "Escape" });
  expect(screen.queryByRole("form")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "New" }));
});

it("rejects duplicate names and invalid phase order without a write", () => {
  const fetch = stubFetch({});
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "feature" } });
  fireEvent.submit(form);
  expect(within(form).getByRole("link", { name: /already exists/ })).toBeTruthy();
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "sample-work" } });
  fireEvent.click(within(form).getByRole("button", { name: "Add step" }));
  const second = within(form).getByRole("group", { name: "Step 2" });
  fireEvent.click(within(second).getByRole("button", { name: "Move up" }));
  fireEvent.submit(form);
  expect(within(form).getByRole("link", { name: /in that order/ })).toBeTruthy();
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("refreshes a stale base explicitly, retains checks and retries with the refreshed version", async () => {
  let attempts = 0;
  const fresh = "b".repeat(64);
  stubFetch({
    "/api/config": { ...config, profiles: { ...profiles, version: fresh } },
    "POST /api/profiles": (init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      attempts++;
      if (attempts === 1) return { status: 409, body: { error: "Profiles changed" } };
      expect(body.base).toBe(fresh);
      expect(body.profile.steps[0].checks[0].text).toBe("Scoped tests pass");
      return {
        status: 201,
        body: { ...profiles, list: [...list, { ...list[0], name: "sample-work" }] },
      };
    },
  });
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.submit(form);
  await screen.findByRole("alert");
  fireEvent.click(within(form).getByRole("button", { name: "Refresh templates" }));
  await waitFor(() =>
    expect(within(form).getByRole("status").textContent).toContain("Templates refreshed"),
  );
  // a successful refresh is news, not a failure: no error summary, no alert
  expect(form.querySelector(".fsum")).toBeNull();
  expect(within(form).queryByRole("alert")).toBeNull();
  fireEvent.submit(form);
  await screen.findByRole("region", { name: "sample-work" });
  expect(attempts).toBe(2);
});

it("announces saving and prevents duplicate submissions while preserving the running view", async () => {
  let finish: (value: Response) => void = () => {};
  const fetch = stubFetch({});
  fetch.mockImplementation((path) =>
    path === "/api/profiles"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(new Response(JSON.stringify({ rows: [], firstRunToday: null }))),
  );
  render(<Loops config={config} />);
  const form = open();
  fill(form);
  fireEvent.submit(form);
  expect(within(form).getByRole("status").textContent).toBe("Saving template…");
  expect(screen.getByRole("region", { name: "Observed loops" })).toBeTruthy();
  fireEvent.submit(form);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  finish(new Response(JSON.stringify({ error: "Save failed" }), { status: 500 }));
  await screen.findByRole("alert");
});

it("shows empty profiles and a failed seat read without claiming a running count", async () => {
  stubFetch({
    "/api/crew?shape=summary": () => ({ status: 500, body: { error: "Crew unavailable" } }),
  });
  const { rerender } = render(<Loops config={config} />);
  expect(screen.getByText("Loading seats on each step…")).toBeTruthy();
  await screen.findByText("Seats on each step unavailable: Crew unavailable");
  expect(screen.getByRole("button", { name: /^feature ·/ }).textContent).not.toContain("running");
  rerender(<Loops config={{ ...config, profiles: { ...profiles, list: [] } }} />);
  expect(screen.getByText("No template profiles.")).toBeTruthy();
});
