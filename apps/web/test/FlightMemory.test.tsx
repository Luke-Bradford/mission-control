import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLIGHT_MEMORY_BODY_MAX,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_SOURCE_MAX,
  FLIGHT_MEMORY_TOPIC_MAX,
  type FlightMemoryNote,
  OPERATOR_BOOTSTRAP_PATH,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_REQUIRED,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { forgetOperatorToken, loadOperatorToken } from "../src/api.ts";
import { hub, RESOURCES } from "../src/data.ts";
import { MemoryPanel } from "../src/flight/Memory.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, MIN, NOW, REPOS } from "./fixtures.ts";

afterEach(() => {
  forgetOperatorToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const note: FlightMemoryNote = {
  repoId: "shop-app",
  topic: "tests/locks",
  kind: "lesson",
  body: "Take the test lock before the suite.",
  source: "RETRO on PR #450",
  author: "flight",
  updatedAt: NOW - MIN,
};
const path = "/api/flight/memory/shop-app/tests%2Flocks";
function stub(extra: Record<string, unknown> = {}) {
  return stubFetch({
    [RESOURCES.repos.path]: REPOS,
    [RESOURCES.config.path]: CONFIG,
    [RESOURCES.flightMemory("shop-app").path]: { notes: [note] },
    [RESOURCES.flightMemory("site-builder").path]: { notes: [] },
    [OPERATOR_BOOTSTRAP_PATH]: { token: "operator-token" },
    ...extra,
  });
}

async function open() {
  render(<MemoryPanel />);
  fireEvent.click(screen.getByText("Memory", { selector: "h2" }));
  await screen.findByText(note.topic);
}

it("starts collapsed and lists notes grouped by kind with author, source, age and evidence labels", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub({
    [RESOURCES.flightMemory("shop-app").path]: {
      notes: FLIGHT_MEMORY_KINDS.map((kind, i) => ({
        ...note,
        kind,
        topic: `Topic ${i}`,
        author: i === 1 ? "operator" : "flight",
      })).reverse(),
    },
  });
  const { container } = render(<MemoryPanel />);
  expect(container.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Memory", { selector: "h2" }));
  await screen.findByText("Topic 0");
  expect(screen.getAllByRole("heading", { level: 3 }).map((el) => el.textContent)).toEqual([
    "Lessons",
    "Repo",
    "Crew",
    "Playbooks",
  ]);
  const lessons = within(screen.getByRole("region", { name: "Lessons" }));
  expect(lessons.getByText("Source: RETRO on PR #450")).toBeTruthy();
  expect(lessons.getByText(/FLIGHT · updated 1 min ago/)).toBeTruthy();
  expect(
    lessons.getByText("Evidence written by FLIGHT from crew material, not an instruction."),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Repo" })).getByText(/you · updated/),
  ).toBeTruthy();
  expect(container.querySelector(".memory-note .expandable")?.textContent).toContain(note.body);
});

it("edits kind, body and source with a fixed topic, encodes slashes and refreshes the notes", async () => {
  let notes = [note];
  const fetch = stub({
    [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }),
    [`PUT ${path}`]: (init: RequestInit) => {
      notes = [{ ...note, ...JSON.parse(init.body as string), author: "operator" }];
      return { status: 200, body: { ok: true } };
    },
  });
  await loadOperatorToken();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("form", { name: `Edit ${note.topic}` })).toBeTruthy();
  expect(screen.getByLabelText("Topic")).toHaveProperty("readOnly", true);
  fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "playbook" } });
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Corrected procedure" } });
  fireEvent.change(screen.getByLabelText("Source (required)"), {
    target: { value: "Operator review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const group = await screen.findByRole("region", { name: "Playbooks" });
  expect(within(group).getByText("Corrected procedure")).toBeTruthy();
  expect(within(group).getByText(/you · updated/)).toBeTruthy();
  const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(put?.[0]).toBe(path);
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({
    kind: "playbook",
    body: "Corrected procedure",
    source: "Operator review",
  });
  expect(new Headers(put?.[1]?.headers).get(OPERATOR_HEADER)).toBe("operator-token");
  expect(screen.queryByRole("form")).toBeNull();
});

it("requires confirmation before deleting, sends no body or content type, and refreshes", async () => {
  let notes = [note];
  const fetch = stub({
    [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }),
    [`DELETE ${path}`]: () => {
      notes = [];
      return { status: 200, body: { ok: true } };
    },
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
  await loadOperatorToken();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining(note.topic));
  expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No memory notes for this repo.");
  const deletion = fetch.mock.calls.find(([, init]) => init?.method === "DELETE");
  expect(deletion?.[0]).toBe(path);
  expect(deletion?.[1]).not.toHaveProperty("body");
  const headers = new Headers(deletion?.[1]?.headers);
  expect(headers.has("content-type")).toBe(false);
  expect(headers.get(OPERATOR_HEADER)).toBe("operator-token");
});

it("adds a note in the selected repo with a required source and shared field limits", async () => {
  const fetch = stub({ "PUT /api/flight/memory/site-builder/new%2Ftopic": { ok: true } });
  await open();
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "site-builder" } });
  await screen.findByText("No memory notes for this repo.");
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  expect(screen.getByRole("form", { name: "Add note" })).toBeTruthy();
  expect(screen.getByLabelText("Topic")).toHaveProperty("readOnly", false);
  expect(screen.getByLabelText("Topic")).toHaveProperty("maxLength", FLIGHT_MEMORY_TOPIC_MAX);
  expect(screen.getByLabelText("Body")).toHaveProperty("maxLength", FLIGHT_MEMORY_BODY_MAX);
  expect(screen.getByLabelText("Source (required)")).toHaveProperty(
    "maxLength",
    FLIGHT_MEMORY_SOURCE_MAX,
  );
  expect(screen.getByLabelText("Source (required)")).toHaveProperty("required", true);
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "new/topic" } });
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "A new note" } });
  fireEvent.change(screen.getByLabelText("Source (required)"), { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Source (required)"), { target: { value: "My review" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(put?.[0]).toBe("/api/flight/memory/site-builder/new%2Ftopic");
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({
    kind: "lesson",
    body: "A new note",
    source: "My review",
  });
});

it.each([
  [400, "Invalid memory note", "PUT"],
  [409, "memory full", "PUT"],
  [404, `No note named ${note.topic}.`, "DELETE"],
  [401, OPERATOR_TOKEN_REQUIRED, "PUT"],
] as const)("shows the server's %s error inline", async (status, error, method) => {
  stub({ [`${method} ${path}`]: () => ({ status, body: { error } }) });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await open();
  if (method === "PUT") {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  }
  expect((await screen.findByRole("alert")).textContent).toBe(error);
  expect(screen.getByText(note.topic)).toBeTruthy();
});

it("refreshes on flight events and drops an edit when switching repos", async () => {
  let notes = [note];
  stub({ [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }) });
  await open();
  notes = [{ ...note, body: "Updated by FLIGHT" }];
  act(() => hub.refetchTopic("flight"));
  await screen.findByText("Updated by FLIGHT");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("form", { name: `Edit ${note.topic}` })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "site-builder" } });
  await screen.findByText("No memory notes for this repo.");
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.queryByText(note.topic)).toBeNull();
});

it("preserves newlines and indentation in note bodies", async () => {
  const body = "First line\n\n  Indented line\nLast line";
  stub({ [RESOURCES.flightMemory("shop-app").path]: { notes: [{ ...note, body }] } });
  await open();
  const text = screen.getByRole("listitem").querySelector(".expandable-text");
  expect(text?.textContent).toBe(body);
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css).toMatch(/\.memory-note \.expandable-text\s*\{[^}]*white-space: pre-wrap;/);
});

it("blocks Add for an existing topic after case and whitespace normalization", async () => {
  const existing = { ...note, topic: "Test Locks", kind: "playbook" };
  const fetch = stub({
    [RESOURCES.flightMemory("shop-app").path]: { notes: [note, existing] },
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  const form = screen.getByRole("form", { name: "Add note" });
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "  TEST   locks  " } });
  fireEvent.change(screen.getByLabelText("Source (required)"), { target: { value: "Review" } });
  expect(screen.getByRole("alert").textContent).toBe("A note named Test Locks exists; use Edit.");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.submit(form);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Different topic" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
});

it.each([".", "..", " . ", " .. "])("rejects the URL dot-segment topic %s", async (topic) => {
  const fetch = stub();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  const form = screen.getByRole("form", { name: "Add note" });
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: topic } });
  fireEvent.change(screen.getByLabelText("Source (required)"), { target: { value: "Review" } });
  expect(screen.getByRole("alert").textContent).toBe('Topic cannot be "." or "..".');
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.submit(form);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("refetches flight after a failed delete to remove a stale row", async () => {
  let notes = [note];
  stub({
    [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }),
    [`DELETE ${path}`]: () => {
      notes = [];
      return { status: 404, body: { error: `No note named ${note.topic}.` } };
    },
  });
  const refetch = vi.spyOn(hub, "refetchTopic");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No memory notes for this repo.");
  expect(refetch).toHaveBeenCalledWith("flight");
  expect(screen.queryByText(note.topic)).toBeNull();
});

it("keeps a successfully deleted row busy until the refetch removes it", async () => {
  const fetch = stub({ [`DELETE ${path}`]: { ok: true } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await open();
  let resolveRefresh!: (response: Response) => void;
  const refresh = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  const originalFetch = fetch.getMockImplementation();
  if (!originalFetch) throw new Error("Missing fetch stub");
  fetch.mockImplementation((input, init) =>
    input === RESOURCES.flightMemory("shop-app").path ? refresh : originalFetch(input, init),
  );
  const refetch = vi.spyOn(hub, "refetchTopic");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(refetch).toHaveBeenCalledWith("flight"));
  expect(screen.getByRole("button", { name: "Deleting…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty("disabled", true);
  await act(async () => resolveRefresh(new Response(JSON.stringify({ notes: [] }))));
  await screen.findByText("No memory notes for this repo.");
  expect(screen.queryByText(note.topic)).toBeNull();
});

it("blocks stale edits until the form is reopened with the new version", async () => {
  let notes = [note];
  const fetch = stub({
    [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }),
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const form = screen.getByRole("form", { name: `Edit ${note.topic}` });
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Unsaved changes" } });
  act(() => hub.refetchTopic("flight"));
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([url]) => url === RESOURCES.flightMemory("shop-app").path),
    ).toHaveLength(2),
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  notes = [{ ...note, body: "New version", updatedAt: NOW }];
  act(() => hub.refetchTopic("flight"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This note changed; reopen to see the new version.",
  );
  expect(screen.getByLabelText("Body")).toHaveProperty("value", "Unsaved changes");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.submit(form);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("form", { name: `Edit ${note.topic}` })).toBeTruthy();
  expect(screen.getByLabelText("Body")).toHaveProperty("value", "New version");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
});

it.each(["Add note", "Edit"])("closes the %s form on Cancel without writing", async (action) => {
  const fetch = stub();
  await open();
  fireEvent.click(screen.getByRole("button", { name: action }));
  expect(screen.getByRole("form")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Discard this" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form")).toBeNull();
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("encodes percent signs and Unicode in topics for saving and deleting", async () => {
  const topic = "100%/café 東京";
  const encodedPath = "/api/flight/memory/shop-app/100%25%2Fcaf%C3%A9%20%E6%9D%B1%E4%BA%AC";
  let notes = [note];
  const fetch = stub({
    [RESOURCES.flightMemory("shop-app").path]: () => ({ status: 200, body: { notes } }),
    [`PUT ${encodedPath}`]: () => {
      notes = [note, { ...note, topic }];
      return { status: 200, body: { ok: true } };
    },
    [`DELETE ${encodedPath}`]: () => {
      notes = [note];
      return { status: 200, body: { ok: true } };
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  expect(screen.getByRole("form", { name: "Add note" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: topic } });
  fireEvent.change(screen.getByLabelText("Source (required)"), { target: { value: "Review" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const title = await screen.findByText(topic);
  expect(screen.queryByRole("form")).toBeNull();
  const row = title.closest("li");
  if (!row) throw new Error("Missing memory row");
  fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByText(topic)).toBeNull());
  expect(
    fetch.mock.calls
      .filter(([, init]) => ["PUT", "DELETE"].includes(init?.method ?? ""))
      .map(([url, init]) => [url, init?.method]),
  ).toEqual([
    [encodedPath, "PUT"],
    [encodedPath, "DELETE"],
  ]);
});
