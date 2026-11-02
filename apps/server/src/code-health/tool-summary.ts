import type { CodeHealthView } from "@mc/core";

/** Keep the tool useful when the HUD's full risk table is larger than its response budget. */
export function codeHealthToolSummary(view: CodeHealthView): unknown {
  if (view.data.tab !== "risk") return view;
  const risk = view.data;
  let limit = 20;
  for (;;) {
    const files = risk.files.slice(0, limit),
      coupling = risk.coupling.slice(0, limit),
      sizeHistory = risk.sizeHistory.slice(0, limit);
    const result = {
      ...view,
      data: { ...risk, files, coupling, sizeHistory },
      summaryLimits: {
        omittedFiles: risk.files.length - files.length,
        omittedHistories: risk.sizeHistory.length - sizeHistory.length,
        omittedCouplingPairs: risk.coupling.length - coupling.length,
        note: "Bounded tool summary. Inspect returned evidence references with code_health evidence. The HUD risk tab retains the full bounded table.",
      },
    };
    if (JSON.stringify(result).length <= 115_000 || limit === 0) return result;
    limit = Math.floor(limit / 2);
  }
}
