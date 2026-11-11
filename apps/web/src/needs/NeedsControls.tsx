import type { AttentionItem } from "@mc/core";
import { followLink, needsYouPath } from "../router.ts";
import { NEEDS_ORDERS, type NeedsFilters, type NeedsOrder, ORDER_LABEL } from "./needsView.ts";

export const ALERTS_CHIP = "Alerts";

/** Filters and order for the open-question list. Choices come from the questions as received. */
export function NeedsControls({
  filters,
  onFilters,
  order,
  onOrder,
  repos,
  askers,
}: {
  filters: NeedsFilters;
  onFilters: (f: NeedsFilters) => void;
  order: NeedsOrder;
  onOrder: (o: NeedsOrder) => void;
  repos: readonly string[];
  askers: readonly string[];
}) {
  const set = (k: keyof NeedsFilters) => (v: string) => onFilters({ ...filters, [k]: v });
  return (
    <fieldset className="needs-controls">
      <legend className="sr-only">Filter and order questions</legend>
      <label className="needs-control needs-control-text">
        <span className="s">Search</span>
        <input
          type="search"
          value={filters.text}
          placeholder="Title, question or ticket"
          onChange={(e) => set("text")(e.target.value)}
        />
      </label>
      <label className="needs-control">
        <span className="s">Repo</span>
        <select value={filters.repo} onChange={(e) => set("repo")(e.target.value)}>
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="needs-control">
        <span className="s">Asked by</span>
        <select value={filters.asker} onChange={(e) => set("asker")(e.target.value)}>
          <option value="">Anyone</option>
          {askers.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="needs-control">
        <span className="s">Order</span>
        <select value={order} onChange={(e) => onOrder(e.target.value as NeedsOrder)}>
          {NEEDS_ORDERS.map((o) => (
            <option key={o} value={o}>
              {ORDER_LABEL[o]}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/** Shown only when the hub has raised an alert; it opens the first one at its fix. */
export function AlertsChip({ alerts }: { alerts: readonly AttentionItem[] }) {
  const first = alerts[0];
  if (first === undefined) return null;
  const to = needsYouPath(first.key);
  return (
    <a
      className="needs-alerts-chip"
      href={to}
      data-testid="alerts-chip"
      onClick={(e) => followLink(e, to)}
    >
      {`${ALERTS_CHIP} · ${alerts.length}`}
    </a>
  );
}
