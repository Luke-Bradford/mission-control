import { readFileSync } from "node:fs";
import { FLIGHT_BRIEF_SECTION_MAX, MC_PLAN_MAX } from "@mc/core";
import { expect, it } from "vitest";
import { TICKET_BODY_MAX } from "../src/collectors/github.ts";

it.each([
  ["FAO", MC_PLAN_MAX],
  ["FAO", TICKET_BODY_MAX],
  ["FLIGHT", FLIGHT_BRIEF_SECTION_MAX],
] as const)("%s documents the %s character limit", (role, limit) => {
  const text = readFileSync(new URL(`../../../roles/${role}.md`, import.meta.url), "utf8");
  expect(text).toContain(limit.toLocaleString("en-US"));
});
