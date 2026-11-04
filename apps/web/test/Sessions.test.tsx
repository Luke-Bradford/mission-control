import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sessions } from "../src/setup/Sessions.tsx";
import { closeTopOverlay } from "../src/shell/overlays.ts";
import { getSession, setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG } from "./fixtures.ts";

let lastView: ReturnType<typeof render>;
function mount(routes: Record<string, unknown> = {}) {
  const fetch = stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/crew/changes": { sessions: [], pending: [], restartNeeded: [], error: null },
    "/api/crew/sessions": [],
    ...routes,
  });
  lastView = render(
    <>
      <Sessions config={CREW_CONFIG} />
      <Toast />
    </>,
  );
  return fetch;
}

it("adds two sessions for one repo using returned IDs and folders, selecting and opening Add agent", async () => {
  let n = 0;
  const fetch = mount({
    "POST /api/crew/sessions": () => ({
      status: 200,
      body: { id: `harbor-${++n}`, folders: ["harbor"] },
    }),
  });
  for (const name of ["first", "second"]) {
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));
    const form = screen.getByRole("form", { name: "Add session" });
    fireEvent.change(within(form).getByLabelText("Repo"), {
      target: { value: "/fictional/harbor" },
    });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: name } });
    fireEvent.change(within(form).getByLabelText("Checkout"), { target: { value: "separate" } });
    fireEvent.submit(form);
    await waitFor(() => expect(getSession()).toBe(`harbor-${n}`));
    const panel = await screen.findByRole("region", { name: `s/harbor-${n}` });
    expect(within(panel).getByRole("form", { name: `Add agent to s/harbor-${n}` })).toBeTruthy();
    expect(within(panel).getByText("harbor/: free")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add session" }));
  }
  const posts = fetch.mock.calls.filter(([, i]) => i?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
    source: "/fictional/harbor",
    branch: "feat/new-work",
    checkoutStrategy: "separate",
    id: "first",
    repoId: "shop-app",
  });
});

it("keeps a duplicate refusal visible and allows keyboard cancellation without posting", async () => {
  const fetch = mount({
    "POST /api/crew/sessions": () => ({ status: 409, body: { error: "s/harbor already exists." } }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Add session" }));
  const form = screen.getByRole("form", { name: "Add session" });
  fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "/fictional/harbor" } });
  fireEvent.submit(form);
  expect(await screen.findByText("s/harbor already exists.")).toBeTruthy();
  const repo = within(form).getByLabelText("Repo");
  repo.focus();
  expect(document.activeElement).toBe(repo);
  fireEvent.keyDown(repo, { key: "Escape" });
  expect(screen.queryByRole("form", { name: "Add session" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add session" }));
  expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
});

it("returns focus to Add session after Cancel without posting", () => {
  const fetch = mount();
  fireEvent.click(screen.getByRole("button", { name: "Add session" }));
  const form = screen.getByRole("form", { name: "Add session" });
  const cancel = within(form).getByRole("button", { name: "Cancel" });
  cancel.focus();
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(screen.queryByRole("form", { name: "Add session" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add session" }));
  expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
});

it.each([
  ["removed", null, "s/s1 closed; its separate checkout is removed."],
  ["unmanaged", "/fictional/harbor", "s/s1 closed; repo folder retained: /fictional/harbor."],
  [
    "retained-unproven",
    "/fictional/harbor",
    "s/s1 closed; checkout retained: /fictional/harbor. Safe removal could not be proved.",
  ],
  [
    "removal-failed-partway",
    "/fictional/harbor",
    "s/s1 closed; checkout retained: /fictional/harbor. Safe removal could not be proved.",
  ],
  [
    "retained-dirty",
    "/fictional/harbor",
    "s/s1 closed; checkout retained: /fictional/harbor. The branch has uncommitted changes.",
  ],
  [
    "retained-unpushed",
    "/fictional/harbor",
    "s/s1 closed; checkout retained: /fictional/harbor. The branch has unpushed commits.",
  ],
])("reports %s and resets the closed selection", async (checkout, retainedPath, text) => {
  setSession("s1");
  mount({
    "POST /api/crew/sessions/s1/close": () => ({
      status: 200,
      body: { id: "s1", checkout, retainedPath },
    }),
  });
  const close = await screen.findByRole("button", { name: "Close" });
  close.focus();
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  expect(await screen.findByText(text)).toBeTruthy();
  expect(getSession()).toBe("all");
  expect(screen.queryByRole("region", { name: "s/s1" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add session" }));
});

it("shows the server active-seat refusal and keeps the selected session", async () => {
  setSession("s1");
  mount({
    "POST /api/crew/sessions/s1/close": () => ({
      status: 409,
      body: { error: "Stop or remove the 2 agent(s) in s/s1 first." },
    }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  expect(await screen.findByText("Stop or remove the 2 agent(s) in s/s1 first.")).toBeTruthy();
  expect(getSession()).toBe("s1");
});

it("holds duplicate submissions while loading and shows a failed response", async () => {
  const fetch = mount();
  let release: (r: Response) => void = () => {};
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("missing fetch stub");
  fetch.mockImplementation((p, init) =>
    p === "/api/crew/sessions" && init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : original(p, init),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add session" }));
  const form = screen.getByRole("form", { name: "Add session" });
  fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "/fictional/harbor" } });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(
    (within(form).getByRole("button", { name: "Adding session…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
  expect(
    (within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).closest("fieldset")
      ?.disabled,
  ).toBe(true);
  release(new Response(JSON.stringify({ error: "checkout unavailable" }), { status: 500 }));
  expect(await screen.findByText("checkout unavailable")).toBeTruthy();
  expect(screen.getByRole("form", { name: "Add session" })).toBeTruthy();
});

it("explains an empty repo configuration", () => {
  stubFetch({});
  render(<Sessions config={{ ...CREW_CONFIG, repos: [], crew: null }} />);
  expect(screen.getByText("Add a repo in Setup first.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add session" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

const SEAT = {
  id: "guido-1",
  role: "GUIDO",
  accountId: "claude-main",
  model: "sonnet",
  area: ["apps/**"],
};
const CHANGES = {
  sessions: [{ id: "s1", seats: [SEAT] }],
  pending: [],
  restartNeeded: [],
  error: null,
};
const posts = (fetch: ReturnType<typeof mount>, path: string) =>
  fetch.mock.calls.filter(([p, i]) => p === path && i?.method === "POST");
const SEATS = "/api/crew/sessions/s1/seats";

function hold(fetch: ReturnType<typeof mount>, path: string) {
  const real = fetch.getMockImplementation();
  if (!real) throw new Error("no stub");
  let release: (r: Response) => void = () => {};
  fetch.mockImplementation((p, init) =>
    p === path && init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : real(p, init),
  );
  return (status: number, body: unknown) => release(new Response(JSON.stringify(body), { status }));
}

describe("agent form: grouping and recoverable input", () => {
  const seatMount = async (routes: Record<string, unknown> = {}) => {
    const fetch = mount({ "/api/crew/changes": CHANGES, ...routes });
    const opener = await screen.findByRole("button", { name: "Add agent" });
    await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false));
    opener.focus();
    fireEvent.click(opener);
    const form = screen.getByRole("form", { name: "Add agent to s/s1" });
    return { fetch, opener, form };
  };

  it("groups identity, model and work area, with the hint after its label", async () => {
    const { form } = await seatMount();
    const groups = [...form.querySelectorAll("fieldset > legend")].map((l) => l.textContent);
    expect(groups).toEqual(["Identity", "Model", "Work area"]);
    const area = within(form).getByLabelText("Area");
    const hint = document.getElementById(area.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/click free folder tiles/);
  });

  it("explains an invalid attempt, links to the field, and sends nothing", async () => {
    const { fetch, form } = await seatMount({
      [`POST ${SEATS}`]: () => ({ status: 200, body: {} }),
    });
    const sign = within(form).getByLabelText("Call sign");
    fireEvent.change(sign, { target: { value: "Bad Name" } });
    const submit = within(form).getByRole("button", { name: "Add agent" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    const summary = within(form).getByRole("region", { name: "Fix before saving" });
    expect(document.activeElement).toBe(summary);
    expect(sign.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(within(summary).getByRole("link", { name: /Call sign/ }));
    expect(document.activeElement).toBe(sign);
    expect(posts(fetch, SEATS)).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: " " } });
    fireEvent.click(submit);
    expect(within(form).getByRole("link", { name: /Model/ })).toBeTruthy();
  });

  it("does not let a hidden scratch or area field block a read-only role", async () => {
    const { fetch, form } = await seatMount({
      [`POST ${SEATS}`]: () => ({ status: 200, body: {} }),
    });
    fireEvent.change(within(form).getByLabelText("Area"), { target: { value: "apps/**" } });
    fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "RETRO" } });
    expect(within(form).queryByRole("region")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(posts(fetch, SEATS)).toHaveLength(1));
    expect(JSON.parse(String(posts(fetch, SEATS)[0]?.[1]?.body)).seats[1]).toEqual({
      id: "retro-2",
      role: "RETRO",
      accountId: "claude-main",
      model: "opus",
      area: [],
    });
  });

  it("keeps entries and the target after a refusal, a server fault and a dropped connection", async () => {
    let answer: () => { status: number; body: unknown } = () => ({
      status: 400,
      body: { error: "area overlaps guido-1" },
    });
    const { fetch, form } = await seatMount({ [`POST ${SEATS}`]: () => answer() });
    fireEvent.change(within(form).getByLabelText("Call sign"), { target: { value: "inco-9" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
    const refused = await within(form).findByRole("region", { name: "Not saved" });
    expect(refused.textContent).toContain("Refused: area overlaps guido-1");
    expect(document.activeElement).toBe(refused);
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("value", "inco-9");
    answer = () => ({ status: 500, body: { error: "disk full" } });
    const before = fetch.mock.calls.filter(([p]) => p === "/api/config").length;
    fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
    const unknown = await within(form).findByRole("region", { name: "Result unknown" });
    expect(unknown.textContent).toContain("disk full");
    expect(unknown.textContent).toMatch(/check it before saving again/);
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([p]) => p === "/api/config").length).toBeGreaterThan(before),
    );
    const real = fetch.getMockImplementation();
    fetch.mockImplementation((p, init) =>
      p === SEATS ? Promise.reject(new TypeError("Failed to fetch")) : (real?.(p, init) as never),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
    await waitFor(() =>
      expect(within(form).getByRole("region", { name: "Result unknown" }).textContent).toMatch(
        /Failed to fetch/,
      ),
    );
    expect(screen.getByRole("form", { name: "Add agent to s/s1" })).toBe(form);
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("value", "inco-9");
  });

  it("keeps the draft when the config refreshes under it", async () => {
    const { form } = await seatMount();
    fireEvent.change(within(form).getByLabelText("Call sign"), { target: { value: "inco-9" } });
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "opus" } });
    lastView.rerender(
      <>
        <Sessions config={{ ...CREW_CONFIG, repos: [...CREW_CONFIG.repos] }} />
        <Toast />
      </>,
    );
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("value", "inco-9");
    expect(within(form).getByLabelText("Model")).toHaveProperty("value", "opus");
  });

  it("posts once for Enter plus a click and refuses Cancel and Escape while saving", async () => {
    const { fetch, form } = await seatMount();
    const release = hold(fetch, SEATS);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(posts(fetch, SEATS)).toHaveLength(1);
    expect(within(form).getByRole("status").textContent).toBe("Adding agent to s/s1…");
    expect((within(form).getByLabelText("Model") as HTMLInputElement).disabled).toBe(true);
    expect(
      (within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(within(form).getByLabelText("Model"), { key: "Escape" });
    closeTopOverlay();
    expect(screen.getByRole("form", { name: "Add agent to s/s1" })).toBe(form);
    release(500, { error: "late failure" });
    const summary = await within(form).findByRole("region", { name: "Result unknown" });
    expect(summary.textContent).toContain("late failure");
    expect(posts(fetch, SEATS)).toHaveLength(1);
  });

  it("cancels with no write, returns focus to the opener and never traps Tab", async () => {
    const { fetch, opener, form } = await seatMount();
    const cancel = within(form).getByRole("button", { name: "Cancel" });
    cancel.focus();
    const tab = fireEvent.keyDown(cancel, { key: "Tab" });
    expect(tab).toBe(true); // not prevented: the browser moves focus on
    fireEvent.keyDown(within(form).getByLabelText("Model"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Add agent to s/s1" })).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(posts(fetch, SEATS)).toHaveLength(0);
  });
});

describe("session form: grouping and recoverable input", () => {
  const open = () => {
    const opener = screen.getByRole("button", { name: "Add session" });
    opener.focus();
    fireEvent.click(opener);
    return { opener, form: screen.getByRole("form", { name: "Add session" }) };
  };
  const SESSIONS = "/api/crew/sessions";

  it("groups identity/source and checkout/scope, and states the effect before submit", () => {
    mount();
    const { form } = open();
    expect([...form.querySelectorAll("fieldset > legend")].map((l) => l.textContent)).toEqual([
      "Identity and source",
      "Checkout and scope",
    ]);
    fireEvent.change(within(form).getByLabelText("Repo"), {
      target: { value: "/fictional/harbor" },
    });
    fireEvent.change(within(form).getByLabelText("Checkout"), { target: { value: "separate" } });
    const effect = within(form).getByTestId("session-effect");
    expect(effect.textContent).toContain("s/harbor");
    expect(effect.textContent).toContain("shop-app");
    expect(effect.textContent).toContain("/fictional/harbor");
    expect(effect.textContent).toContain("feat/new-work");
    expect(effect.textContent).toMatch(/separate checkout/);
    fireEvent.change(within(form).getByLabelText("Checkout"), { target: { value: "shared" } });
    expect(effect.textContent).toMatch(/uses the repo folder/);
  });

  it("explains an invalid attempt, links to the field, and posts nothing", () => {
    const fetch = mount();
    const { form } = open();
    const submit = within(form).getByRole("button", { name: "Add session" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    const summary = within(form).getByRole("region", { name: "Fix before saving" });
    expect(document.activeElement).toBe(summary);
    fireEvent.click(within(summary).getByRole("link", { name: /Repo/ }));
    const repo = within(form).getByLabelText("Repo");
    expect(document.activeElement).toBe(repo);
    expect(repo.getAttribute("aria-invalid")).toBe("true");
    expect(posts(fetch, SESSIONS)).toHaveLength(0);
  });

  it("keeps the draft in the form after a refusal, shows it in the summary, and posts the real body", async () => {
    let answer: () => { status: number; body: unknown } = () => ({
      status: 409,
      body: { error: "s/harbor already exists." },
    });
    const fetch = mount({ [`POST ${SESSIONS}`]: () => answer() });
    const { form } = open();
    fireEvent.change(within(form).getByLabelText("Repo"), {
      target: { value: "/fictional/harbor" },
    });
    fireEvent.change(within(form).getByLabelText("Branch"), { target: { value: "feat/x" } });
    fireEvent.submit(form);
    const summary = await within(form).findByRole("region", { name: "Not saved" });
    expect(summary.textContent).toContain("Refused: s/harbor already exists.");
    expect(document.activeElement).toBe(summary);
    expect(within(form).getByLabelText("Branch")).toHaveProperty("value", "feat/x");
    answer = () => ({ status: 200, body: { id: "harbor", folders: [] } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add session" })).toBeNull());
    expect(JSON.parse(String(posts(fetch, SESSIONS)[1]?.[1]?.body))).toEqual({
      repoId: "shop-app",
      source: "/fictional/harbor",
      branch: "feat/x",
      checkoutStrategy: "shared",
      id: "harbor",
    });
  });

  it("reports a dropped connection as unknown and rereads saved state", async () => {
    const fetch = mount();
    const real = fetch.getMockImplementation();
    fetch.mockImplementation((p, init) =>
      p === SESSIONS && init?.method === "POST"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : (real?.(p, init) as never),
    );
    const { form } = open();
    fireEvent.change(within(form).getByLabelText("Repo"), {
      target: { value: "/fictional/harbor" },
    });
    const before = fetch.mock.calls.filter(([p, i]) => p === SESSIONS && !i?.method).length;
    fireEvent.submit(form);
    const summary = await within(form).findByRole("region", { name: "Result unknown" });
    expect(summary.textContent).toMatch(/check it before saving again/);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([p, i]) => p === SESSIONS && !i?.method).length,
      ).toBeGreaterThan(before),
    );
    expect(within(form).getByLabelText("Repo")).toHaveProperty("value", "/fictional/harbor");
  });

  it("ignores Escape and Cancel while the session is being added", async () => {
    const fetch = mount();
    const release = hold(fetch, SESSIONS);
    const { form } = open();
    fireEvent.change(within(form).getByLabelText("Repo"), {
      target: { value: "/fictional/harbor" },
    });
    fireEvent.submit(form);
    expect(within(form).getByRole("status").textContent).toBe("Adding session s/harbor…");
    fireEvent.keyDown(within(form).getByLabelText("Repo"), { key: "Escape" });
    expect(screen.getByRole("form", { name: "Add session" })).toBe(form);
    release(200, { id: "harbor", folders: [] });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add session" })).toBeNull());
    expect(posts(fetch, SESSIONS)).toHaveLength(1);
  });
});
