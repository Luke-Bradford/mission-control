/** The controller merge path for a PR with no unfinished crew run. No synthetic run or gate waiver. */
import { Buffer } from "node:buffer";
import type { RepoRules } from "@mc/core";
import {
  effectiveHardRules,
  FLIGHT_CONTROLLER_CHECK_PATHS,
  FLIGHT_FLOOR_PATHS,
  globMatches,
  REVIEW_STATUS_CONTEXT,
  type ReviewRow,
  type TicketView,
  ticketControllerCheck,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import { parseChecks } from "../collectors/github.ts";
import { type CcConfig, flightPowersOf } from "../config.ts";
import { mcSection } from "../engine/rules.ts";
import {
  externalControlReason,
  externalMergeHold,
  externalPrControl,
  setExternalPrControl,
} from "../external-pr-control.ts";
import { isExternalReview, readExternalSubject } from "../external-reviews.ts";
import { mergeFloorApproval, mergeFloorScope } from "../flight-approvals.ts";
import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";

export async function mergeExternalPr(i: {
  config: CcConfig;
  repo: CcConfig["repos"][number];
  store: Store;
  bus: ChangeBus;
  gh: GhRunner;
  cwd: string;
  number: number;
  rules: () => Promise<RepoRules | Error>;
  now: () => number;
  fetchTicket(repo: CcConfig["repos"][number], number: number): Promise<TicketView | null>;
}): Promise<{ text: string; isError?: boolean }> {
  const fail = (text: string) => ({ text, isError: true as const });
  const { repo, store, number } = i;
  const cached = store.pullRequests(repo.id).find((pr) => pr.number === number);
  const sha = cached?.headSha;
  if (!cached || cached.state !== "open" || !sha || repo.autonomy !== "merge")
    return fail("No open external PR in this merge workspace.");
  if (store.hasUnfinishedBuildRun(repo.id, cached.branch))
    return fail("This branch belongs to a crew run; use its normal merge path.");
  const runHold = store.branchMergeHold(repo.id, cached.branch);
  if (runHold) return fail(`This PR has a merge hold from ${runHold.by}: ${runHold.reason}`);
  let rules: RepoRules;
  try {
    const loaded = await i.rules();
    if (loaded instanceof Error) return fail("The repository rules could not be read.");
    rules = loaded;
  } catch {
    return fail("The repository rules could not be read.");
  }
  if (!rules.hardRulesSet)
    return fail("The repository's hard-rule list must be set before merging.");
  const held = externalMergeHold(store, repo.id, number);
  if (held !== null) return fail(`This PR has an operator merge hold: ${held}`);
  const read = async (args: string[]): Promise<unknown> => {
    const reply = await i.gh(args, { cwd: i.cwd });
    if (reply.code !== 0) throw new Error("The PR merge evidence could not be read.");
    return JSON.parse(reply.stdout);
  };
  try {
    const subject = await readExternalSubject(i.gh, i.cwd, repo, number, sha);
    if (!subject) return fail("The PR's current head, origin, target or review opt-out changed.");
    const view = await read([
      "pr",
      "view",
      String(number),
      `--repo=${repo.github}`,
      "--json=headRefOid,baseRefOid,changedFiles,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences",
    ]);
    if (view === null || typeof view !== "object")
      return fail("The PR merge evidence is incomplete.");
    const facts = view as {
      headRefOid?: unknown;
      baseRefOid?: unknown;
      changedFiles?: unknown;
      reviewDecision?: unknown;
      mergeable?: unknown;
      statusCheckRollup?: unknown;
      closingIssuesReferences?: unknown;
    };
    if (
      facts.headRefOid !== sha ||
      facts.mergeable !== "MERGEABLE" ||
      !Array.isArray(facts.statusCheckRollup) ||
      !Array.isArray(facts.closingIssuesReferences)
    )
      return fail("The current PR head and mergeability could not be verified.");
    if (facts.reviewDecision === "CHANGES_REQUESTED" || facts.reviewDecision === "REVIEW_REQUIRED")
      return fail("GitHub reviews still hold this PR.");
    const checks = parseChecks({ contexts: { nodes: facts.statusCheckRollup } });
    if (
      checks.length !== facts.statusCheckRollup.length ||
      checks.some((check) => check.state !== "passing") ||
      !checks.some((check) => check.name !== REVIEW_STATUS_CONTEXT) ||
      !checks.some((check) => check.name === REVIEW_STATUS_CONTEXT && check.state === "passing")
    )
      return fail("CI and mc/review must pass on this exact head.");
    const crewBranch = store
      .runsOnBranch(repo.id, cached.branch)
      .some((run) => run.reviewId == null);
    const clean = (row: ReviewRow) =>
      row.state === "reported" &&
      row.blocking === 0 &&
      row.verdict?.spec === "pass" &&
      row.verdict.quality === "pass";
    const reviewProof = () => {
      const rows = store.reviewsOfPr(repo.id, number).filter((row) => row.sha === sha);
      // #91 respects a real external mc/review status when the hub has no attempt for this head.
      // Never manufacture a scratch report or revive a superseded/failed attempt to represent it.
      // A branch with a crew build run is different: its mc/review status may be the crew's own
      // (waived or carried), so that head still needs an external review row.
      if (rows.length === 0) return crewBranch ? undefined : null;
      const live = rows.filter((value) => value.state !== "superseded");
      const external = live.findLast((row) => isExternalReview(row) && clean(row));
      if (!external) return undefined;
      // a later row that reported a problem (or failed) still blocks; a later clean crew row does not
      const blocked = live
        .slice(live.indexOf(external) + 1)
        .some((row) => row.state === "failed" || (row.state === "reported" && !clean(row)));
      return blocked ? undefined : external;
    };
    const review = reviewProof();
    if (review === undefined)
      return fail("An independent clean QA report is required on this exact head.");
    const pages = await read([
      "api",
      `repos/${repo.github}/pulls/${number}/files?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray))
      return fail("The PR's complete changed-file list could not be read.");
    const files = pages.flat() as {
      filename?: unknown;
      previous_filename?: unknown;
      status?: unknown;
    }[];
    if (
      !Number.isSafeInteger(facts.changedFiles) ||
      files.length !== facts.changedFiles ||
      files.some(
        (file) =>
          typeof file?.filename !== "string" ||
          typeof file.status !== "string" ||
          (file.previous_filename != null && typeof file.previous_filename !== "string"),
      )
    )
      return fail("The PR's changed-file list is incomplete.");
    const paths = files.flatMap((file) => [
      file.filename as string,
      ...(typeof file.previous_filename === "string" ? [file.previous_filename] : []),
    ]);
    const tickets: TicketView[] = [];
    const numbers = new Set<number>();
    for (const reference of facts.closingIssuesReferences) {
      if (
        reference === null ||
        typeof reference !== "object" ||
        !Number.isSafeInteger(reference.number) ||
        reference.number < 1 ||
        typeof reference.url !== "string" ||
        !reference.url.startsWith(`https://github.com/${repo.github}/issues/`)
      )
        return fail("A closing issue's repository could not be verified.");
      numbers.add(reference.number);
    }
    if (cached.ticket?.startsWith(`${repo.id}#`))
      numbers.add(Number(cached.ticket.slice(repo.id.length + 1)));
    for (const ticketNumber of numbers) {
      if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1)
        return fail("The linked ticket could not be verified.");
      const ticket = await i.fetchTicket(repo, ticketNumber);
      if (!ticket || ticket.bodyTruncated)
        return fail("A linked ticket must be read whole before merging.");
      tickets.push(ticket);
    }
    for (const source of [subject.ticket, ...tickets]) {
      const lanes = [...new Set(source.labels.filter((label) => label.startsWith("lane:")))];
      if (
        lanes.length > 1 ||
        (i.config.crew?.lane && lanes.length === 1 && lanes[0] !== `lane:${i.config.crew.lane}`)
      )
        return fail("The PR or linked ticket belongs to another lane.");
    }
    const labels = [...subject.ticket.labels, ...tickets.flatMap((ticket) => ticket.labels)];
    const matches = (patterns: readonly string[], values: readonly string[]) =>
      values.some((value) => patterns.some((pattern) => globMatches(pattern, value, true)));
    let floor = matches(
      FLIGHT_FLOOR_PATHS.filter((path) => path !== "CLAUDE.md"),
      paths,
    );
    const claude = files.find(
      (file) => file.filename === "CLAUDE.md" || file.previous_filename === "CLAUDE.md",
    );
    if (claude) {
      const section = async (ref: unknown, absent: boolean): Promise<string | null> => {
        if (absent) return null;
        if (typeof ref !== "string" || !/^[a-f0-9]{40}$/.test(ref))
          throw new Error("Missing CLAUDE.md provenance.");
        const value = (await read([
          "api",
          `repos/${repo.github}/contents/CLAUDE.md?ref=${ref}`,
        ])) as { encoding?: unknown; content?: unknown };
        if (
          value?.encoding !== "base64" ||
          typeof value.content !== "string" ||
          value.content.length > 100_000
        )
          throw new Error("CLAUDE.md could not be read whole.");
        return mcSection(Buffer.from(value.content, "base64").toString("utf8"));
      };
      floor ||=
        (await section(facts.baseRefOid, claude.status === "added")) !==
        (await section(sha, claude.status === "removed"));
    }
    const hard = matches(effectiveHardRules(rules, flightPowersOf(i.config, repo.id)), paths);
    const approvalRequired =
      floor || matches(rules.alwaysAsk, labels) || (hard && rules.hardRulesBy === "operator");
    const approval = approvalRequired ? mergeFloorApproval(store, number, sha, i.now()) : undefined;
    if (approvalRequired && !approval)
      return fail(
        `The repository requires controller approval for this head. Record merge-floor approval for ${mergeFloorScope(number, sha)}.`,
      );
    const current = externalPrControl(store, repo.id, number, sha);
    const control = {
      since: current?.since ?? i.now(),
      uatRequired: matches(rules.uat.labels, labels) || matches(rules.uat.paths, paths),
      uatAccepted: current?.uatAccepted ?? false,
      controllerRequired:
        tickets.some((ticket) => ticketControllerCheck(ticket) !== null) ||
        matches(FLIGHT_CONTROLLER_CHECK_PATHS, paths),
      protectedController: matches(FLIGHT_CONTROLLER_CHECK_PATHS, paths),
      controllerPassed: current?.controllerPassed ?? false,
      note: current?.note ?? null,
    };
    setExternalPrControl(store, repo.id, number, sha, control);
    const reason = externalControlReason(store, repo.id, number, sha);
    if (reason !== null) {
      i.bus.emit("boards");
      return fail(reason);
    }
    // Recheck provenance and local holds after all awaited reads; GitHub atomically matches the head.
    const latestRules = await i.rules();
    const finalSubject = await readExternalSubject(i.gh, i.cwd, repo, number, sha);
    const finalFacts = await read([
      "pr",
      "view",
      String(number),
      `--repo=${repo.github}`,
      "--json=headRefOid,baseRefOid,changedFiles,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences",
    ]);
    if (finalFacts === null || typeof finalFacts !== "object")
      return fail("The final PR checks could not be verified.");
    const final = finalFacts as {
      headRefOid?: unknown;
      baseRefOid?: unknown;
      changedFiles?: unknown;
      closingIssuesReferences?: unknown;
      reviewDecision?: unknown;
      mergeable?: unknown;
      statusCheckRollup?: unknown;
    };
    const finalChecks = parseChecks({ contexts: { nodes: final.statusCheckRollup } });
    const latestReview = reviewProof();
    if (
      latestRules instanceof Error ||
      JSON.stringify(latestRules) !== JSON.stringify(rules) ||
      latestReview === undefined ||
      latestReview?.id !== review?.id ||
      (approvalRequired && !mergeFloorApproval(store, number, sha, i.now()))
    )
      return fail("The repository rules, review or controller approval changed before merge.");
    if (
      !finalSubject ||
      finalSubject.branch !== subject.branch ||
      finalSubject.ticket.body !== subject.ticket.body ||
      JSON.stringify(finalSubject.ticket.labels) !== JSON.stringify(subject.ticket.labels) ||
      final.headRefOid !== sha ||
      final.baseRefOid !== facts.baseRefOid ||
      final.changedFiles !== facts.changedFiles ||
      JSON.stringify(final.closingIssuesReferences) !==
        JSON.stringify(facts.closingIssuesReferences) ||
      final.mergeable !== "MERGEABLE" ||
      !Array.isArray(final.statusCheckRollup) ||
      finalChecks.length !== final.statusCheckRollup.length ||
      finalChecks.some((check) => check.state !== "passing") ||
      !finalChecks.some((check) => check.name === REVIEW_STATUS_CONTEXT) ||
      !finalChecks.some((check) => check.name !== REVIEW_STATUS_CONTEXT) ||
      (final.reviewDecision !== null && !["", "APPROVED"].includes(String(final.reviewDecision))) ||
      externalControlReason(store, repo.id, number, sha) !== null ||
      store.pullRequests(repo.id).find((pr) => pr.number === number)?.headSha !== sha ||
      store.hasUnfinishedBuildRun(repo.id, finalSubject.branch) ||
      store.branchMergeHold(repo.id, finalSubject.branch)
    )
      return fail("The PR head, checks, ownership or hold changed before merge.");
    const merged = await i.gh(
      [
        "pr",
        "merge",
        String(number),
        `--repo=${repo.github}`,
        "--merge",
        `--match-head-commit=${sha}`,
      ],
      { cwd: i.cwd },
    );
    if (merged.code !== 0)
      return fail("GitHub refused the merge; its repository gates remain in force.");
    const after = await read([
      "pr",
      "view",
      String(number),
      `--repo=${repo.github}`,
      "--json=state,headRefOid",
    ]);
    if (
      after === null ||
      typeof after !== "object" ||
      !("state" in after) ||
      after.state !== "MERGED" ||
      !("headRefOid" in after) ||
      after.headRefOid !== sha
    )
      return fail("The merge result is not confirmed; refresh GitHub before retrying.");
    i.bus.emit("boards");
    return {
      text: `Merged external PR #${number} at ${sha}.${approval ? " Used the controller's recorded approval." : ""}`,
    };
  } catch {
    return fail(
      "The external PR's merge evidence could not be verified; nothing further was requested.",
    );
  }
}
