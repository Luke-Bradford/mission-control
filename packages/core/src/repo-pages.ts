import { HUD_PAGE_PATHS } from "./flight.ts";

/** What a page that reads a repository's board says on a hub with none set up. */
export const REPO_REQUIRED_TEXT = "This page needs a repository: add one on Setup › Repos.";

/** The pages that read a configured repository's board, tickets or plans. */
const REPO_PAGES: ReadonlySet<string> = new Set(["board", "planner", "qa"]);

/** Whether a HUD page (by its HUD_PAGE_PATHS key) shows nothing without a repository. */
export const needsRepo = (page: string): boolean => REPO_PAGES.has(page);

/** Where `/` lands: Sessions on a hub with no repository (a sessions-only hub), else the Overview. */
export const homePath = (repoCount: number): string =>
  repoCount === 0 ? HUD_PAGE_PATHS.sessions : HUD_PAGE_PATHS.overview;
