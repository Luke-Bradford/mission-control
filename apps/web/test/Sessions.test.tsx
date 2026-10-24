import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { Sessions } from "../src/setup/Sessions.tsx";
import { getSession, setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG } from "./fixtures.ts";

function mount(routes: Record<string, unknown> = {}) {
  const fetch = stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/crew": { rows: [], firstRunToday: null },
    "/api/crew/changes": { sessions: [], pending: [], restartNeeded: [], error: null },
    "/api/crew/sessions": [],
    ...routes,
  });
  render(
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
  fireEvent.keyDown(form, { key: "Escape" });
  expect(screen.queryByRole("form", { name: "Add session" })).toBeNull();
  expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
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
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  expect(await screen.findByText(text)).toBeTruthy();
  expect(getSession()).toBe("all");
  expect(screen.queryByRole("region", { name: "s/s1" })).toBeNull();
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

it("disables duplicate submissions while loading and shows a failed response", async () => {
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
  expect(
    (within(form).getByRole("button", { name: "Add session" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "/fictional/harbor" } });
  fireEvent.submit(form);
  expect(
    (within(form).getByRole("button", { name: "Adding session…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
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
