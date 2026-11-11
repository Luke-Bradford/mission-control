import type { CommsTicketCounts } from "@mc/core";
import type { CcConfig } from "./config.ts";
import type { Store } from "./store.ts";

const issue = (text: string): number | null => {
  if (!/^[1-9]\d*$/.test(text)) return null;
  const value = Number(text);
  return value <= 2 ** 31 - 1 ? value : null;
};

/** Resolve retained structured references, keeping ambiguous legacy messages out of guessed totals. */
export function commsTicketCounts(config: CcConfig, store: Store): CommsTicketCounts {
  const repos = new Set(config.repos.map((r) => r.id));
  const senderRepos = new Map(
    config.crew?.sessions.flatMap((s) => s.seats.map((seat) => [seat.id, s.repoId] as const)),
  );
  const counts = new Map<string, number>();
  const rows = store.commsTicketReferenceCounts();
  const prNumbers = rows.flatMap((row) =>
    [row.ticket, row.ref].flatMap((value) => {
      const number = /^PR ([1-9]\d*)$/.exec(value ?? "")?.[1];
      const parsed = number === undefined ? null : issue(number);
      return parsed === null ? [] : [parsed];
    }),
  );
  const links = new Map(
    store.commsPrTicketLinks(prNumbers).map((pr) => [`${pr.repoId}\0${pr.number}`, pr]),
  );
  let unassignedCount = 0;
  for (const row of rows) {
    const tickets = new Set<string>();
    const qualified =
      /^([^#]+)#([1-9]\d*)$/.exec(row.ticket ?? "") ?? /^([^#]+)#([1-9]\d*)$/.exec(row.ref ?? "");
    if (qualified !== null) {
      const repoId = qualified[1] ?? "";
      const number = issue(qualified[2] ?? "");
      if (repos.has(repoId) && number !== null) tickets.add(`${repoId}#${number}`);
    } else {
      const repoId = senderRepos.get(row.from) ?? (repos.size === 1 ? [...repos][0] : undefined);
      const ref = row.ticket ?? row.ref ?? "";
      const short = /^#([1-9]\d*)$/.exec(ref)?.[1];
      const pr = /^PR ([1-9]\d*)$/.exec(ref)?.[1];
      if (repoId !== undefined && repos.has(repoId)) {
        const number = short === undefined ? null : issue(short);
        if (number !== null) tickets.add(`${repoId}#${number}`);
        const link = pr === undefined ? undefined : links.get(`${repoId}\0${pr}`);
        if (link !== undefined) {
          const match = /^([^#]+)#([1-9]\d*)$/.exec(link.ticket ?? "");
          if (match?.[1] === repoId && issue(match[2] ?? "") !== null)
            tickets.add(link.ticket as string);
          for (const n of link.closingIssues)
            if (Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1) tickets.add(`${repoId}#${n}`);
        }
      }
    }
    if (tickets.size === 0) unassignedCount += row.count;
    for (const ticket of tickets) counts.set(ticket, (counts.get(ticket) ?? 0) + row.count);
  }
  return {
    tickets: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticket, count]) => ({ ticket, count })),
    unassignedCount,
  };
}
