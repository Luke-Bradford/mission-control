import { expect, it } from "vitest";
import { ATTACH_MATERIALS_DESCRIPTION } from "../src/flight.ts";

it("attach_materials promises no deletion: the hub keeps what it stores", () => {
  expect(ATTACH_MATERIALS_DESCRIPTION).not.toMatch(/delet|30 days/i);
  expect(ATTACH_MATERIALS_DESCRIPTION).toContain("up to 24 MB per question");
});
