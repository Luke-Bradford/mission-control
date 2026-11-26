import { expect, it } from "vitest";
import { HUD_PAGE_PATHS, homePath, needsRepo, REPO_REQUIRED_TEXT } from "../src/index.ts";

it("a hub with no repository opens on Sessions; one with a repository on the Overview", () => {
  expect(homePath(0)).toBe(HUD_PAGE_PATHS.sessions);
  expect(homePath(1)).toBe(HUD_PAGE_PATHS.overview);
});

it("the board, planner and QA pages need a repository; Sessions and the rest do not", () => {
  expect(needsRepo("board")).toBe(true);
  expect(needsRepo("planner")).toBe(true);
  expect(needsRepo("qa")).toBe(true);
  for (const page of ["sessions", "overview", "flight", "telemetry", "setup", "comms"])
    expect(needsRepo(page)).toBe(false);
});

it("says in one line what to do", () => {
  expect(REPO_REQUIRED_TEXT).not.toContain("\n");
  expect(REPO_REQUIRED_TEXT).toContain("Setup");
});
