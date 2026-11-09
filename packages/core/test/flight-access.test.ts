import { expect, it } from "vitest";
import { flightOperatorAllowed } from "../src/flight-access.ts";

it("mc operator may POST a review request for an external PR, and nothing near it", () => {
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/review-request")).toBe(true);
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/uat")).toBe(false);
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/review-request/x")).toBe(false);
});

it("mc operator may not write the slow pace, so only the operator can slow the crew", () => {
  expect(flightOperatorAllowed("POST", "/api/settings/pace")).toBe(false);
});
