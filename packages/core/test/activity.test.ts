import { expect, it } from "vitest";
import { CHECK_EVENT } from "../src/activity.ts";

it.each([
  "CI passed on abc",
  "CI failed on abc",
  "CI flaked on abc",
  "CI passed on the re-run of abc",
  "CI failed again on the re-run of abc",
])("classifies %s as a check", (text) => expect(CHECK_EVENT.test(text)).toBe(true));
it("leaves non-check events as loop activity", () =>
  expect(CHECK_EVENT.test("CI failed 3 times")).toBe(false));
