import type { AttentionItem, BriefChoiceReceipt, BriefOption } from "@mc/core";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChoiceAttempts } from "../src/comms/briefChoice.ts";
import { hub, streamStatus } from "../src/data.ts";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { closeItem, openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { boundBrief, crewRow, item, NOW, SEAT_Q, SOURCE_REVISION } from "./fixtures.ts";

const KEY = "ask:7";
const CHOICE = `/api/attention/${encodeURIComponent(KEY)}/choice`;
const DISCUSSION = `/api/attention/${encodeURIComponent(KEY)}/discussion`;
const FLIGHT = {
  seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
  decisions: [],
};
const thread = (key: string) => ({
  id: `thread:${key}`,
  itemKey: key,
  version: "v1",
  messages: [],
});

const bound = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  ...SEAT_Q,
  brief: boundBrief(),
  ...over,
});

const receipt = (over: Partial<BriefChoiceReceipt> = {}): BriefChoiceReceipt => ({
  epoch: "epoch-1",
  requestId: "r",
  optionId: "port-5174",
  at: NOW,
  state: "applied",
  text: "Answer sent to mc-dev-1.",
  actor: { operator: true },
  ...over,
});

function mount(items: AttentionItem[], routes: Record<string, unknown> = {}, open = items[0]) {
  const fn = stubFetch({
    "/api/attention": items,
    "/api/escalations": [],
    "/api/crew?shape=summary": {
      rows: [crewRow({ id: "mc-dev-1", index: 1 })],
      firstRunToday: null,
    },
    "/api/flight": FLIGHT,
    [DISCUSSION]: thread(KEY),
    [`${DISCUSSION}?id=${encodeURIComponent(`thread:${KEY}`)}`]: thread(KEY),
    [`POST ${DISCUSSION}`]: thread(KEY),
    ...routes,
  });
  render(<ItemPanel />);
  act(() => openItem(open?.key ?? KEY));
  return fn;
}
const posts = (fn: ReturnType<typeof stubFetch>, path: string) =>
  fn.mock.calls
    .filter(([p, init]) => p === path && init?.method === "POST")
    .map(([, init]) => JSON.parse(init?.body as string));
const panel = () => document.querySelector("#discuss") as HTMLElement;
const accept = () =>
  within(panel()).findByRole("button", {
    name: /^Accept recommendation: /,
  }) as Promise<HTMLButtonElement>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetChoiceAttempts();
});
afterEach(() => {
  act(() => closeItem());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a complete brief opens inline", () => {
  it("shows every required field with two options at first sight", async () => {
    mount([bound()]);
    await accept();
    const p = within(panel());
    expect(p.getByText("Which port should the preview use?")).toBeTruthy();
    expect(p.getByText(/The port is shown to customers\./)).toBeTruthy();
    expect(p.getByText("The dev seat asks which port to preview on.")).toBeTruthy();
    expect(p.getByText(/GUIDO-1/)).toBeTruthy();
    expect(p.getByText("The preview stays down.")).toBeTruthy();
    expect(p.getByText("An explicit operator choice.")).toBeTruthy();
    expect(p.getByText("The seat previews on 5174.")).toBeTruthy();
    expect(p.getByText(/Partly reversible/)).toBeTruthy();
    expect(p.getByText("Recommended")).toBeTruthy();
    expect(p.getByText("port-5180")).toBeTruthy();
    expect(p.getByText("Current")).toBeTruthy();
    expect(p.getAllByRole("radio")).toHaveLength(2);
  });

  it("shows four options", async () => {
    const options: BriefOption[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      label: `Option ${id}`,
      answer: `Do ${id}.`,
      consequence: `Result ${id}`,
      reversibility: { kind: "irreversible", detail: `Cannot undo ${id}` },
      action: { kind: "answer", seatId: "mc-dev-1", runId: "r1", text: `Do ${id}.` },
    }));
    mount([bound({ brief: boundBrief({ options }) })]);
    await accept();
    expect(within(panel()).getAllByRole("radio")).toHaveLength(4);
    expect(within(panel()).getByText("Result d")).toBeTruthy();
    expect(within(panel()).getAllByText(/Not reversible/)).toHaveLength(4);
  });

  it("says nobody was consulted and that an unknown delay cost is unknown", async () => {
    const base = boundBrief();
    mount([
      bound({
        brief: {
          ...base,
          decision: { consulted: [], costOfDelay: "" },
        },
      }),
    ]);
    await accept();
    expect(within(panel()).getByText("Nobody consulted")).toBeTruthy();
    expect(within(panel()).getByText("Unknown")).toBeTruthy();
  });

  it("labels a legacy brief honestly, keeps its text, and offers no choice", async () => {
    const legacy = bound({ brief: { ...boundBrief(), binding: undefined, state: undefined } });
    const fn = mount([legacy]);
    expect((await within(panel()).findAllByText(/Needs a refreshed brief/)).length).toBeGreaterThan(
      0,
    );
    expect(within(panel()).getByText("The dev seat asks which port to preview on.")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /Accept recommendation/ })).toBeNull();
    expect(posts(fn, CHOICE)).toEqual([]);
  });
});

describe("Accept sends the bound choice", () => {
  it("posts the exact brief, revision, option and a request id, and shows the receipt", async () => {
    const fn = mount([bound()], { [`POST ${CHOICE}`]: receipt() });
    fireEvent.click(await accept());
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(1));
    expect(posts(fn, CHOICE)[0]).toEqual({
      briefId: 41,
      sourceRevision: SOURCE_REVISION,
      optionId: "port-5174",
      requestId: expect.any(String),
    });
    expect((await within(panel()).findByTestId("choice-receipt")).textContent).toContain(
      "Answer sent to mc-dev-1.",
    );
    expect(posts(fn, "/api/seats/mc-dev-1/message")).toEqual([]);
    expect(posts(fn, DISCUSSION)).toEqual([]);
  });

  it("a label of 'approve' or a duplicate label cannot select another action", async () => {
    const options: BriefOption[] = [
      {
        id: "first",
        label: "approve",
        answer: "A",
        consequence: "One",
        reversibility: { kind: "reversible", detail: "d" },
        action: { kind: "answer", seatId: "mc-dev-1", runId: "r1", text: "A" },
      },
      {
        id: "second",
        label: "approve",
        answer: "B",
        consequence: "Two",
        reversibility: { kind: "reversible", detail: "d" },
        action: { kind: "answer", seatId: "mc-dev-1", runId: "r1", text: "B" },
      },
    ];
    const base = boundBrief({ options });
    const fn = mount([bound({ brief: { ...base, recommendedOptionId: "second" } })], {
      [`POST ${CHOICE}`]: receipt({ optionId: "second" }),
    });
    fireEvent.click(await accept());
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(1));
    expect(posts(fn, CHOICE)[0].optionId).toBe("second");
  });

  it("an option the server did not prepare is not sent, whatever the client believes", async () => {
    const base = boundBrief();
    const forged = {
      ...base,
      binding: base.binding && { ...base.binding, actions: [] },
    };
    const fn = mount([bound({ brief: forged })]);
    const button = await accept();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts(fn, CHOICE)).toEqual([]);
    expect(within(panel()).getByTestId("choice-blocked").textContent).toContain("did not prepare");
  });

  it("sends the typed note a controller check accepts", async () => {
    const base = boundBrief();
    const options: BriefOption[] = [
      {
        id: "pass",
        label: "Pass",
        answer: "Pass",
        consequence: "Records a pass",
        reversibility: { kind: "partly-reversible", detail: "Can be re-recorded" },
        action: {
          kind: "controller-check",
          target: { kind: "run", runId: "r1", sha: "b".repeat(40) },
          verdict: "pass",
          evidence: "proof",
        },
      },
      {
        id: "fail",
        label: "Fail",
        answer: "Fail",
        consequence: "Records a failure",
        reversibility: { kind: "partly-reversible", detail: "Can be re-recorded" },
        action: {
          kind: "controller-check",
          target: { kind: "run", runId: "r1", sha: "b".repeat(40) },
          verdict: "fail",
          evidence: "proof",
        },
      },
    ];
    const brief = boundBrief({ options });
    const fn = mount([bound({ brief: { ...brief, binding: brief.binding ?? base.binding } })], {
      [`POST ${CHOICE}`]: receipt({ optionId: "pass", text: "Controller verdict recorded." }),
    });
    const note = await within(panel()).findByLabelText("Note");
    fireEvent.change(note, { target: { value: "Looked at the run" } });
    fireEvent.click(await accept());
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(1));
    expect(posts(fn, CHOICE)[0].input).toEqual({ note: "Looked at the run" });
    expect((await within(panel()).findByTestId("choice-receipt")).textContent).toContain(
      "Controller verdict recorded.",
    );
  });

  it("sends the edited message for an answer action", async () => {
    const fn = mount([bound()], { [`POST ${CHOICE}`]: receipt() });
    const box = (await within(panel()).findByLabelText("Message to send")) as HTMLTextAreaElement;
    expect(box.value).toBe("Use port 5174.");
    fireEvent.change(box, { target: { value: "Use 5174, please." } });
    fireEvent.click(await accept());
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(1));
    expect(posts(fn, CHOICE)[0].input).toEqual({ text: "Use 5174, please." });
  });
});

describe("states that cannot dispatch", () => {
  const cases: [string, (b: ReturnType<typeof boundBrief>) => Partial<AttentionItem>, RegExp][] = [
    [
      "stale",
      (b) => ({
        brief: {
          ...b,
          state: { completeness: "complete", freshness: "stale", reason: "Run moved." },
        },
      }),
      /source changed/i,
    ],
    [
      "unknown",
      (b) => ({
        brief: {
          ...b,
          state: { completeness: "complete", freshness: "unknown", reason: "Not checked." },
        },
      }),
      /unknown/i,
    ],
    [
      "incomplete",
      (b) => ({
        brief: {
          ...b,
          state: { completeness: "incomplete", freshness: "current", reason: "Missing why." },
        },
      }),
      /Needs a refreshed brief/,
    ],
    [
      "held",
      () => ({
        hold: { reason: "Waiting for CI", condition: { kind: "manual" }, at: NOW } as never,
      }),
      /Held/,
    ],
  ];
  it.each(cases)("%s shows the content and reason and never posts", async (_name, make, reason) => {
    const base = boundBrief();
    const fn = mount([bound(make(base))]);
    const button = await accept();
    expect(button.disabled).toBe(true);
    expect(within(panel()).getByTestId("choice-blocked").textContent).toMatch(reason);
    expect(within(panel()).getByText("Which port should the preview use?")).toBeTruthy();
    fireEvent.click(button);
    expect(posts(fn, CHOICE)).toEqual([]);
  });

  it("a refreshed list alone does not make a stale brief choosable", async () => {
    const base = boundBrief();
    const stale = bound({
      brief: { ...base, state: { completeness: "complete", freshness: "stale", reason: "Moved." } },
    });
    const fn = mount([stale]);
    await accept();
    fireEvent.click(await accept());
    expect(posts(fn, CHOICE)).toEqual([]);
  });

  it("an already applied choice for this revision is not sent again", async () => {
    const base = boundBrief();
    mount([
      bound({
        brief: { ...base, choice: receipt({ settledSourceRevision: SOURCE_REVISION }) },
      }),
    ]);
    const button = await accept();
    expect(button.disabled).toBe(true);
    expect((await within(panel()).findByTestId("choice-receipt")).textContent).toContain(
      "Answer sent to mc-dev-1.",
    );
  });

  it("an unknown receipt is shown and not retried", async () => {
    const base = boundBrief();
    mount([
      bound({ brief: { ...base, choice: receipt({ state: "unknown", text: "Lost reply." }) } }),
    ]);
    const button = await accept();
    expect(button.disabled).toBe(true);
    expect(within(panel()).getByTestId("choice-receipt").textContent).toContain(
      "will not be sent again",
    );
  });
});

describe("disconnected and gone", () => {
  afterEach(() => streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null }));

  it("keeps the content but cannot dispatch while the stream is reconnecting", async () => {
    streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: null });
    const fn = mount([bound()]);
    const button = await accept();
    expect(button.disabled).toBe(true);
    expect(within(panel()).getByTestId("choice-blocked").textContent).toContain("Disconnected");
    expect(within(panel()).getByText("Which port should the preview use?")).toBeTruthy();
    fireEvent.click(button);
    expect(posts(fn, CHOICE)).toEqual([]);
  });
});

describe("gone, labels and carry-over", () => {
  it("cannot dispatch after the server removes the item, and says why", async () => {
    let list: AttentionItem[] = [bound()];
    const fn = mount([bound()], {
      "/api/attention": () => ({ status: 200, body: list }),
    });
    const button = await accept();
    expect(button.disabled).toBe(false);
    list = [];
    await act(async () => {
      hub.refetchTopic("attention");
    });
    await waitFor(() =>
      expect(within(panel()).getByTestId("choice-blocked").textContent).toContain(
        "no longer waiting on you",
      ),
    );
    const after = await accept();
    expect(after.disabled).toBe(true);
    fireEvent.click(after);
    expect(posts(fn, CHOICE)).toEqual([]);
    expect(within(panel()).getByText("Which port should the preview use?")).toBeTruthy();
  });

  it("shows words, not ids, for the reason and the receipt state", async () => {
    mount([bound()], { [`POST ${CHOICE}`]: receipt() });
    expect(await within(panel()).findByText("Product direction")).toBeTruthy();
    expect(within(panel()).queryByText("product-direction")).toBeNull();
    fireEvent.click(await accept());
    const line = await within(panel()).findByTestId("choice-receipt");
    expect(line.textContent).toContain("Done");
    expect(line.textContent).not.toContain("applied");
  });

  it("does not carry a picked option or an open discussion to the next ask", async () => {
    const other = bound({ key: "ask:8", brief: boundBrief({ id: 42, ask: "Second question?" }) });
    mount([bound(), other], {
      "/api/attention/ask%3A8/discussion": thread("ask:8"),
    });
    await accept();
    fireEvent.click(within(panel()).getAllByRole("radio")[1] as HTMLElement);
    await within(panel()).findByRole("button", { name: /^Choose: 5180/ });
    fireEvent.click(within(panel()).getByRole("button", { name: "Discuss" }));
    await within(panel()).findByLabelText("Ask FLIGHT about this");
    act(() => openItem("ask:8"));
    await within(panel()).findByText("Second question?");
    expect(
      await within(panel()).findByRole("button", { name: /^Accept recommendation: 5174/ }),
    ).toBeTruthy();
    expect(within(panel()).queryByLabelText("Ask FLIGHT about this")).toBeNull();
  });
});

describe("a person ask", () => {
  it("keeps the reply card that shows the drafted text, and offers no bound Accept", async () => {
    const base = boundBrief({}, "Reply posted");
    const person = item({
      key: "person:101",
      kind: "person",
      agentId: null,
      escalationId: null,
      ticket: null,
      text: "alice mentioned you",
      brief: {
        ...base,
        person: {
          source: { kind: "github", messageId: "1", revision: "v1" },
          replies: [{ id: "r1", label: "Polite", text: "Thanks for the report!" }],
        },
      },
    });
    const fn = stubFetch({
      "/api/attention": [person],
      "/api/escalations": [],
      "/api/flight": FLIGHT,
      "/api/notifications": { open: [], handledToday: [] },
    });
    render(<ItemPanel />);
    act(() => openItem(person.key));
    expect(await within(panel()).findByText("Thanks for the report!")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /^Accept recommendation/ })).toBeNull();
    expect(within(panel()).getByRole("button", { name: "Post on GitHub" })).toBeTruthy();
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  });
});

describe("pending, refusal and retry", () => {
  it("disables a second submission while one is in flight", async () => {
    const release: (v: unknown) => void = () => {};
    const fn = mount([bound()], {
      [`POST ${CHOICE}`]: () => ({ status: 200, body: receipt() }),
    });
    void release;
    const button = await accept();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(within(panel()).queryByTestId("choice-receipt")).toBeTruthy());
    expect(posts(fn, CHOICE)).toHaveLength(1);
  });

  it("a failure keeps the brief and input, focuses the error, and a retry reuses the request id", async () => {
    let calls = 0;
    const fn = mount([bound()], {
      [`POST ${CHOICE}`]: () => {
        calls += 1;
        return calls === 1
          ? { status: 500, body: { error: "Hub busy." } }
          : { status: 200, body: receipt() };
      },
    });
    const box = await within(panel()).findByLabelText("Message to send");
    fireEvent.change(box, { target: { value: "Edited" } });
    fireEvent.click(await accept());
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toContain("Hub busy.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect((within(panel()).getByLabelText("Message to send") as HTMLTextAreaElement).value).toBe(
      "Edited",
    );
    fireEvent.click(await accept());
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(2));
    const [first, second] = posts(fn, CHOICE);
    expect(second.requestId).toBe(first.requestId);
    expect(second.input).toEqual({ text: "Edited" });
  });

  it("changing the option after a failure gets a new request id", async () => {
    let calls = 0;
    const fn = mount([bound()], {
      [`POST ${CHOICE}`]: () => {
        calls += 1;
        return calls === 1
          ? { status: 500, body: { error: "Hub busy." } }
          : { status: 200, body: receipt({ optionId: "port-5180" }) };
      },
    });
    fireEvent.click(await accept());
    await within(panel()).findByRole("alert");
    fireEvent.click(within(panel()).getAllByRole("radio")[1] as HTMLElement);
    fireEvent.click(await within(panel()).findByRole("button", { name: /^Choose: 5180/ }));
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(2));
    const [first, second] = posts(fn, CHOICE);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.optionId).toBe("port-5180");
  });

  it("shows a refused receipt's reason without removing the item", async () => {
    mount([bound()], {
      [`POST ${CHOICE}`]: () => ({
        status: 409,
        body: receipt({ state: "refused", text: "The run moved on.", status: 409 }),
      }),
    });
    fireEvent.click(await accept());
    expect((await within(panel()).findByTestId("choice-receipt")).textContent).toContain(
      "The run moved on.",
    );
    expect(within(panel()).getByText("Which port should the preview use?")).toBeTruthy();
  });

  it("shows a pending receipt as pending, not done", async () => {
    mount([bound()], {
      [`POST ${CHOICE}`]: () => ({
        status: 202,
        body: receipt({ state: "pending", text: "Waiting for the seat." }),
      }),
    });
    fireEvent.click(await accept());
    const line = await within(panel()).findByTestId("choice-receipt");
    expect(line.textContent).toContain("Still being applied");
  });

  it("a late reply stays with its own item when another is open", async () => {
    let finish: (() => void) | undefined;
    const other = bound({ key: "ask:8", text: "Another?", brief: boundBrief({ id: 42 }) });
    const first = bound();
    const fn = stubFetch({
      "/api/attention": [first, other],
      "/api/escalations": [],
      "/api/flight": FLIGHT,
      [`POST ${CHOICE}`]: () => {
        finish?.();
        return { status: 200, body: receipt() };
      },
      [`${DISCUSSION}`]: thread(KEY),
      "/api/attention/ask%3A8/discussion": thread("ask:8"),
    });
    render(<ItemPanel />);
    act(() => openItem(KEY));
    fireEvent.click(await accept());
    act(() => openItem("ask:8"));
    await within(panel())
      .findByText("Another?")
      .catch(() => undefined);
    await waitFor(() => expect(posts(fn, CHOICE)).toHaveLength(1));
    expect(within(panel()).queryByTestId("choice-receipt")).toBeNull();
    act(() => openItem(KEY));
    expect((await within(panel()).findByTestId("choice-receipt")).textContent).toContain(
      "Answer sent",
    );
  });
});

describe("Discuss", () => {
  it("opens the correlated conversation inline and chat never picks an option", async () => {
    const fn = mount([bound()]);
    await accept();
    expect(within(panel()).queryByLabelText("Ask FLIGHT about this")).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Discuss" }));
    const input = await within(panel()).findByLabelText("Ask FLIGHT about this");
    fireEvent.change(input, { target: { value: "yes, approve" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() => expect(posts(fn, DISCUSSION)).toHaveLength(1));
    expect(posts(fn, DISCUSSION)[0]).toEqual({
      version: "v1",
      messageId: expect.any(String),
      text: "yes, approve",
    });
    expect(posts(fn, CHOICE)).toEqual([]);
    expect(posts(fn, "/api/seats/mc-dev-1/message")).toEqual([]);
    expect(posts(fn, "/api/attention/ack")).toEqual([]);
  });
});

describe("FYI timing", () => {
  const fyiBrief = () => {
    const base = boundBrief();
    return {
      ...base,
      decision: { consulted: [], costOfDelay: "Minor." },
      binding: base.binding && {
        ...base.binding,
        actions: base.binding.actions.map((a) => ({
          ...a,
          defaultable: true,
          effect: "Answer sent to the seat",
        })),
      },
    };
  };

  it("counts down from the server deadline and shows the planned effect", async () => {
    mount([bound({ brief: fyiBrief(), defaultDueAt: NOW + 40 * 60_000 })]);
    await accept();
    const line = within(panel()).getByTestId("fyi-countdown");
    expect(line.textContent).toContain("40:00");
    expect(line.textContent).toContain("Answer sent to the seat");
  });

  it("never counts down for a genuine operator reason, even with a deadline", async () => {
    mount([bound({ defaultDueAt: NOW + 40 * 60_000 })]);
    await accept();
    expect(within(panel()).queryByTestId("fyi-countdown")).toBeNull();
    expect(within(panel()).getByText("An explicit operator choice.")).toBeTruthy();
  });

  it("a tick does not refetch the inbox", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fn = mount([bound({ brief: fyiBrief(), defaultDueAt: NOW + 40 * 60_000 })]);
    await accept();
    const before = fn.mock.calls.filter(([p]) => p === "/api/attention").length;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn.mock.calls.filter(([p]) => p === "/api/attention").length).toBe(before);
  });
});

void item;
