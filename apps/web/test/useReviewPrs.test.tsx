import type { CrewRow } from "@mc/core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReviewPrs } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { prView, seatRow } from "./fixtures.ts";

const PRS = "/api/repos/shop-app/prs?linked=1";
const review = { prNumber: 77, state: "open" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

const hook = (row?: CrewRow) => renderHook(() => useReviewPrs(row));

describe("useReviewPrs", () => {
  it("is undefined while the repo's PRs load, then the PRs", async () => {
    stubFetch({ [PRS]: [prView({ number: 77 })] });
    const { result } = hook(seatRow({ hudState: "running", review }));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.map((p) => p.number)).toEqual([77]));
  });

  it("is an empty list when they fail to load, so a line can settle on the seat's last words", async () => {
    stubFetch({ [PRS]: () => ({ status: 500, body: { error: "down" } }) });
    const { result } = hook(seatRow({ hudState: "idle", review }));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("fetches nothing without a row, for a seat with a note, without a review, or for a loop", async () => {
    const f = stubFetch({ [PRS]: [prView()] });
    const rows = [
      undefined,
      seatRow({ hudState: "idle", note: "Rate limited", review }),
      seatRow({ hudState: "idle", review: null }),
      seatRow({ kind: "loop", hudState: "idle", review }),
    ];
    for (const row of rows) {
      const { result } = hook(row);
      expect(result.current).toBeUndefined();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(f).not.toHaveBeenCalled();
  });
});
