import { expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.ts";

const options = {
  member: { type: "string" },
  agent: { type: "string" },
  port: { type: "string" },
  help: { type: "boolean" },
} as const;
const DASH_ID = "-5l4ypzw2oAqOhho-lJvOdimt7ExNNet-cIrR4d76HA";
const DOUBLE_DASH_ID = "--l4ypzw2oAqOhho-lJvOdimt7ExNNet-cIrR4d76HA";

it("keeps member ids that start with one or two dashes as positionals", () => {
  for (const id of [DASH_ID, DOUBLE_DASH_ID]) {
    expect(parseCliArgs(["approve", "home-work", id], options).positionals).toEqual([
      "approve",
      "home-work",
      id,
    ]);
  }
});

it("keeps dash-led option values and still parses long options", () => {
  expect(parseCliArgs(["daemon", "--agent", DASH_ID], options).values).toEqual({ agent: DASH_ID });
  expect(parseCliArgs(["daemon", "--agent", DOUBLE_DASH_ID], options).values).toEqual({
    agent: DOUBLE_DASH_ID,
  });
  expect(parseCliArgs(["init", "--member=-abc", "--help"], options).values).toEqual({
    member: "-abc",
    help: true,
  });
  expect(parseCliArgs(["relay", "--port", "-1"], options).values).toEqual({ port: "-1" });
});

it("treats a lone dash, a dash after a boolean and args after -- as positionals", () => {
  expect(parseCliArgs(["x", "-", "--help", "-abc", "--", "-id"], options)).toEqual({
    values: { help: true },
    positionals: ["x", "-", "-abc", "-id"],
  });
});

it("turns a short flag into a positional and still refuses an unknown long option", () => {
  expect(parseCliArgs(["-h"], options).positionals).toEqual(["-h"]);
  expect(() => parseCliArgs(["init", "--nope"], options)).toThrow(/Unknown option '--nope'/);
});
