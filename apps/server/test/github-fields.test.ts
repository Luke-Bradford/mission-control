import { describe, expect, it } from "vitest";
import { projectFields, singleSelectField } from "../src/github-fields.ts";

describe("project field selections", () => {
  it("keeps names-only previews and ids for setup", () => {
    expect(projectFields(false)).toBe(
      "... on ProjectV2FieldCommon { name }\n... on ProjectV2SingleSelectField { options { name } }",
    );
    expect(projectFields(true)).toBe(
      "... on ProjectV2FieldCommon { id name }\n... on ProjectV2SingleSelectField { options { id name } }",
    );
  });

  it("selects display names for collectors and option ids for board moves", () => {
    expect(singleSelectField("status", "Status")).toBe(
      'status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }',
    );
    expect(singleSelectField("status", "Status", "optionId")).toBe(
      'status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } }',
    );
  });
});
