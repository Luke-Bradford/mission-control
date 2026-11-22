import { prListPath } from "@mc/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPrActions } from "../src/agent/RunPrActions.tsx";
import { OperatorActions } from "../src/setup/OperatorActions.tsx";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => vi.unstubAllGlobals());

const SHA = "a".repeat(40);
const PR = { repoId: "shop-app", number: 7, title: "Hand PR", state: "open", headSha: SHA };

function mount() {
  const fetch = stubFetch({
    "/api/config": { repos: [{ id: "shop-app" }] },
    [prListPath("shop-app")]: [PR],
    "POST /api/settings/pace": { ok: true },
    "POST /api/flight/approvals": { ok: true },
    "POST /api/prs/shop-app/7/review-request": { ok: true },
    "POST /api/prs/shop-app/7/merge-hold": { ok: true },
    "POST /api/prs/shop-app/7/controller-check": { ok: true },
  });
  render(<OperatorActions />);
  return fetch;
}
const posts = (fetch: ReturnType<typeof mount>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([path, init]) => [path, JSON.parse(String(init?.body))]);

async function choosePr() {
  await screen.findByRole("option", { name: "shop-app" });
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "shop-app" } });
  await screen.findByRole("option", { name: /#7 Hand PR/ });
  fireEvent.change(screen.getByLabelText("Open PR"), { target: { value: "7" } });
}

describe("OperatorActions", () => {
  it("saves slow pace with its five fields", async () => {
    const fetch = mount();
    fireEvent.click(screen.getByLabelText("On"));
    fireEvent.change(screen.getByLabelText("Slow pace until"), {
      target: { value: "1900000000000" },
    });
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: "a, b" } });
    fireEvent.change(screen.getByLabelText("Max starts"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "weekend" } });
    fireEvent.click(screen.getByRole("button", { name: "Save slow pace" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]).toEqual([
      "/api/settings/pace",
      { on: true, until: 1900000000000, labels: ["a", "b"], maxStarts: 3, note: "weekend" },
    ]);
  });

  it("grants a FLIGHT approval with an ISO until", async () => {
    const fetch = mount();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "shop-app#7" } });
    fireEvent.change(screen.getByLabelText("Approval until"), {
      target: { value: "2026-11-23T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "checked" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant approval" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    const [path, body] = posts(fetch)[0] as [string, { until: string; scope: string }];
    expect(path).toBe("/api/flight/approvals");
    expect(body.until).toMatch(/^2026-11-2\d{1}T.*Z$/);
    expect(body.scope).toBe("shop-app#7");
  });

  it("posts PR actions with the head sha, and a fail needs a note", async () => {
    const fetch = mount();
    await choosePr();
    fireEvent.click(screen.getByRole("button", { name: "Ask for review" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]).toEqual([
      "/api/prs/shop-app/7/review-request",
      { sha: SHA, action: "ask" },
    ]);
    const fail = screen.getByRole("button", { name: "Fail controller check" }) as HTMLButtonElement;
    expect(fail.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("PR note"), { target: { value: "broken" } });
    fireEvent.click(fail);
    await waitFor(() => expect(posts(fetch)).toHaveLength(2));
    expect(posts(fetch)[1]).toEqual([
      "/api/prs/shop-app/7/controller-check",
      { sha: SHA, verdict: "fail", note: "broken" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(3));
    expect(posts(fetch)[2]).toEqual([
      "/api/prs/shop-app/7/merge-hold",
      { sha: SHA, action: "release" },
    ]);
  });
});

describe("RunPrActions", () => {
  it("holds a merge with a reason and records a controller check on the head", async () => {
    const fetch = stubFetch({
      "POST /api/runs/r1/merge-hold": { ok: true },
      "POST /api/runs/r1/controller-check": { ok: true },
    });
    render(<RunPrActions runId="r1" sha={SHA} />);
    fireEvent.change(screen.getByLabelText("Merge hold reason"), { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Hold merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Pass controller check" }));
    await waitFor(() => expect(posts(fetch as never)).toHaveLength(2));
    expect(posts(fetch as never)).toEqual([
      ["/api/runs/r1/merge-hold", { action: "hold", reason: "wait" }],
      ["/api/runs/r1/controller-check", { verdict: "pass", sha: SHA }],
    ]);
  });
});
