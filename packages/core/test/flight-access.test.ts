import { expect, it } from "vitest";
import { flightOperatorAllowed } from "../src/flight-access.ts";

it("mc operator may POST a review request for an external PR, and nothing near it", () => {
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/review-request")).toBe(true);
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/uat")).toBe(false);
  expect(flightOperatorAllowed("POST", "/api/prs/mc/7/review-request/x")).toBe(false);
});
