import { TYPE_LABELS } from "@mc/core";
import { describe, expect, it } from "vitest";
import type { Gql } from "../src/collectors/github.ts";
import { ensureFields, ensureLabels, readStatusField, setupStatus } from "../src/github-setup.ts";

type Field = { name: string; options?: { name: string }[] };

/** A fake GitHub project: records every call, applies createProjectV2Field to its own fields. */
function fakeProject(initial: Field[] = [], failOn?: string, type = "User") {
  const fields = [...initial];
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const gql: Gql = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes("mutation")) {
      const input = vars.input as { name: string; singleSelectOptions: { name: string }[] };
      if (input.name === failOn) throw new Error("github: boom");
      fields.push({ name: input.name, options: input.singleSelectOptions });
      return { createProjectV2Field: { projectV2Field: { name: input.name } } };
    }
    return {
      repositoryOwner: {
        __typename: type,
        projectV2: { id: "PVT_1", fields: { pageInfo: { hasNextPage: false }, nodes: fields } },
      },
    };
  };
  const mutations = () => calls.filter((c) => c.query.includes("mutation"));
  return { gql, calls, mutations };
}

describe("ensureFields", () => {
  it("creates Stage, Owner, Priority and Size with the exact options when all are missing", async () => {
    const p = fakeProject([{ name: "Status", options: [{ name: "Todo" }] }]);
    const res = await ensureFields(p.gql, "octo-org", 2);
    expect(res).toEqual({ created: ["Stage", "Owner", "Priority", "Size"], mismatched: [] });
    expect(p.mutations().map((m) => m.vars)).toEqual([
      {
        input: {
          projectId: "PVT_1",
          dataType: "SINGLE_SELECT",
          name: "Stage",
          singleSelectOptions: [
            { name: "Needs detail", color: "YELLOW", description: "" },
            { name: "Ready", color: "GREEN", description: "" },
          ],
        },
      },
      {
        input: {
          projectId: "PVT_1",
          dataType: "SINGLE_SELECT",
          name: "Owner",
          singleSelectOptions: [
            { name: "PM", color: "PURPLE", description: "" },
            { name: "CTO", color: "BLUE", description: "" },
            { name: "Agent", color: "GRAY", description: "" },
            { name: "Operator", color: "ORANGE", description: "" },
          ],
        },
      },
      {
        input: {
          projectId: "PVT_1",
          dataType: "SINGLE_SELECT",
          name: "Priority",
          singleSelectOptions: [
            { name: "P0", color: "RED", description: "" },
            { name: "P1", color: "ORANGE", description: "" },
            { name: "P2", color: "YELLOW", description: "" },
          ],
        },
      },
      {
        input: {
          projectId: "PVT_1",
          dataType: "SINGLE_SELECT",
          name: "Size",
          singleSelectOptions: ["XS", "S", "M", "L", "XL"].map((name) => ({
            name,
            color: "BLUE",
            description: "",
          })),
        },
      },
    ]);
  });

  it("creates only the missing two when Stage and Owner already exist", async () => {
    const p = fakeProject([
      { name: "Stage", options: ["Needs detail", "Ready"].map((name) => ({ name })) },
      { name: "Owner", options: ["PM", "CTO", "Agent", "Operator"].map((name) => ({ name })) },
    ]);
    const res = await ensureFields(p.gql, "octo-org", 2);
    expect(res).toEqual({ created: ["Priority", "Size"], mismatched: [] });
    expect(p.mutations().map((m) => (m.vars.input as { name: string }).name)).toEqual([
      "Priority",
      "Size",
    ]);
  });

  it("is idempotent: a second call creates nothing and sends no mutation", async () => {
    const p = fakeProject();
    await ensureFields(p.gql, "octo-org", 2);
    const before = p.mutations().length;
    expect(await ensureFields(p.gql, "octo-org", 2)).toEqual({ created: [], mismatched: [] });
    expect(p.mutations().length).toBe(before);
  });

  it("reports a Stage with other options as mismatched and never modifies it", async () => {
    const p = fakeProject([{ name: "Stage", options: [{ name: "Todo" }, { name: "Done" }] }]);
    const res = await ensureFields(p.gql, "octo-org", 2);
    expect(res).toEqual({
      created: ["Owner", "Priority", "Size"],
      mismatched: [{ field: "Stage", options: ["Todo", "Done"] }],
    });
    expect(p.mutations().map((m) => (m.vars.input as { name: string }).name)).toEqual([
      "Owner",
      "Priority",
      "Size",
    ]);
  });

  it("never sends any mutation other than createProjectV2Field", async () => {
    const p = fakeProject([{ name: "Stage", options: [{ name: "x" }] }]);
    await ensureFields(p.gql, "octo-org", 2);
    await setupStatus(p.gql, "octo-org", 2);
    for (const m of p.mutations()) {
      const fields = (m.query.match(/\b[a-z]\w*(?=\()/gi) ?? []).filter((f) => f !== "mutation");
      expect(fields).toEqual(["createProjectV2Field"]);
    }
  });

  it("does not claim a failed field as created: it throws", async () => {
    const p = fakeProject([], "Owner");
    await expect(ensureFields(p.gql, "octo-org", 2)).rejects.toThrow("boom");
  });

  it("throws when the project does not exist", async () => {
    const gql: Gql = async () => ({ repositoryOwner: null });
    await expect(setupStatus(gql, "octo-org", 9)).rejects.toThrow("not found");
  });
});

describe("setupStatus", () => {
  it("lists missing fields and writes nothing", async () => {
    const p = fakeProject([
      { name: "Owner", options: ["PM", "CTO", "Agent", "Operator"].map((name) => ({ name })) },
    ]);
    expect(await setupStatus(p.gql, "octo-org", 2)).toEqual({
      projectId: "PVT_1",
      missing: ["Stage", "Priority", "Size"],
      mismatched: [],
    });
    expect(p.mutations()).toEqual([]);
  });

  it("reads an organisation's project", async () => {
    const p = fakeProject(
      [{ name: "Owner", options: ["PM", "CTO", "Agent", "Operator"].map((name) => ({ name })) }],
      undefined,
      "Organization",
    );
    expect(await setupStatus(p.gql, "octo-org", 2)).toEqual({
      projectId: "PVT_1",
      missing: ["Stage", "Priority", "Size"],
      mismatched: [],
    });
    expect(p.calls[0]?.query).toContain("repositoryOwner(login:");
  });
});

describe("readStatusField", () => {
  const gqlWith = (fields: unknown[], type = "User") => {
    const sent: string[] = [];
    const gql: Gql = async (query) => {
      sent.push(query);
      return {
        repositoryOwner: {
          __typename: type,
          projectV2: { id: "PVT_1", fields: { pageInfo: { hasNextPage: false }, nodes: fields } },
        },
      };
    };
    return { gql, sent };
  };

  it("returns the project, field and option ids, and asks GitHub for them", async () => {
    const p = gqlWith([
      { id: "F_title", name: "Title" },
      {
        id: "F_status",
        name: "Status",
        options: [
          { id: "O_todo", name: "Todo" },
          { id: "O_review", name: "In review" },
        ],
      },
    ]);
    expect(await readStatusField(p.gql, "octo-org", 2)).toEqual({
      projectId: "PVT_1",
      fieldId: "F_status",
      options: [
        { id: "O_todo", name: "Todo" },
        { id: "O_review", name: "In review" },
      ],
    });
    expect(p.sent[0]).toMatch(/\.\.\. on ProjectV2FieldCommon \{ id name \}/);
    expect(p.sent[0]).toMatch(/options \{ id name \}/);
  });

  it("reads an organisation's project", async () => {
    const p = gqlWith(
      [
        {
          id: "F_status",
          name: "Status",
          options: [
            { id: "O_todo", name: "Todo" },
            { id: "O_review", name: "In review" },
          ],
        },
      ],
      "Organization",
    );
    expect(await readStatusField(p.gql, "octo-org", 2)).toEqual({
      projectId: "PVT_1",
      fieldId: "F_status",
      options: [
        { id: "O_todo", name: "Todo" },
        { id: "O_review", name: "In review" },
      ],
    });
  });

  it("throws when there is no Status field with ids", async () => {
    const noStatus = gqlWith([{ id: "F", name: "Title" }]);
    await expect(readStatusField(noStatus.gql, "octo-org", 2)).rejects.toThrow("Status");
    const noIds = gqlWith([{ name: "Status", options: [{ name: "Todo" }] }]);
    await expect(readStatusField(noIds.gql, "octo-org", 2)).rejects.toThrow("Status");
  });
});

describe("ensureLabels", () => {
  /** A fake repository: its labels (served two to a page), every call made, and createLabel. */
  function fakeRepo(existing: string[] = [], failOn?: string) {
    const labels = [...existing];
    const calls: { query: string; vars: Record<string, unknown> }[] = [];
    const gql: Gql = async (query, vars) => {
      calls.push({ query, vars });
      if (query.includes("createLabel")) {
        const input = vars.input as { name: string };
        if (input.name === failOn) throw new Error("github: HTTP 500");
        labels.push(input.name);
        return { createLabel: { label: { name: input.name } } };
      }
      const from = vars.after === null ? 0 : Number(vars.after);
      const nodes = labels.slice(from, from + 2).map((name) => ({ name }));
      const more = from + 2 < labels.length;
      return {
        repository: {
          id: "R_1",
          existing: {
            pageInfo: { hasNextPage: more, endCursor: more ? String(from + 2) : null },
            nodes,
          },
        },
      };
    };
    const creates = () => calls.filter((c) => c.query.includes("createLabel"));
    return { gql, calls, creates };
  }
  const area = { name: "area:server", color: "ededed" };

  it("creates each label with its colour on the repository found by owner and name", async () => {
    const r = fakeRepo();
    const made = await ensureLabels(r.gql, "octo-org/proj", [...TYPE_LABELS, area]);
    expect(made).toEqual([...TYPE_LABELS.map((l) => l.name), "area:server"]);
    expect(r.calls[0]?.vars).toEqual({ owner: "octo-org", name: "proj", after: null });
    expect(r.creates()[0]?.vars).toEqual({
      input: { repositoryId: "R_1", name: "type:feature", color: "1d76db" },
    });
    expect(r.creates().at(-1)?.vars).toEqual({
      input: { repositoryId: "R_1", name: "area:server", color: "ededed" },
    });
  });

  it("reads the existing labels (all pages, any case) and creates only the missing ones", async () => {
    const r = fakeRepo(["bug", "Type:Bug", "other", "area:server", "x"]);
    const made = await ensureLabels(r.gql, "octo-org/proj", [...TYPE_LABELS, area]);
    expect(made).toEqual(["type:feature", "type:chore", "type:test", "type:docs", "type:research"]);
    expect(r.creates().map((c) => (c.vars.input as { name: string }).name)).toEqual(made);
    expect(
      r.calls.filter((c) => !c.query.includes("createLabel")).map((c) => c.vars.after),
    ).toEqual([null, "2", "4"]);
  });

  it("throws, creating nothing, when the label list cannot be read in full", async () => {
    const calls: string[] = [];
    const gql: Gql = async (query) => {
      calls.push(query);
      return {
        repository: { id: "R_1", existing: { pageInfo: { hasNextPage: true }, nodes: [] } },
      };
    };
    await expect(ensureLabels(gql, "octo-org/proj", TYPE_LABELS)).rejects.toThrow("labels");
    expect(calls.some((q) => q.includes("createLabel"))).toBe(false);
  });

  it("is idempotent: a second call creates nothing", async () => {
    const r = fakeRepo();
    await ensureLabels(r.gql, "octo-org/proj", TYPE_LABELS);
    expect(await ensureLabels(r.gql, "octo-org/proj", TYPE_LABELS)).toEqual([]);
  });

  it("throws on any other failure", async () => {
    const r = fakeRepo([], "type:bug");
    await expect(ensureLabels(r.gql, "octo-org/proj", TYPE_LABELS)).rejects.toThrow("HTTP 500");
  });

  it("throws, creating nothing, when the repository is not found", async () => {
    const calls: string[] = [];
    const gql: Gql = async (query) => {
      calls.push(query);
      return { repository: null };
    };
    await expect(ensureLabels(gql, "octo-org/proj", TYPE_LABELS)).rejects.toThrow("not found");
    expect(calls.some((q) => q.includes("createLabel"))).toBe(false);
  });

  it("sends no mutation other than createLabel", async () => {
    const r = fakeRepo();
    await ensureLabels(r.gql, "octo-org/proj", TYPE_LABELS);
    for (const c of r.calls.filter((c) => c.query.includes("mutation"))) {
      const fields = (c.query.match(/\b[a-z]\w*(?=\()/gi) ?? []).filter((f) => f !== "mutation");
      expect(fields).toEqual(["createLabel"]);
    }
  });
});

describe("setup field read fails closed", () => {
  const readOnly = (fields: unknown) => {
    const sent: string[] = [];
    const gql: Gql = async (query) => {
      sent.push(query);
      return { repositoryOwner: { projectV2: { id: "PVT_1", fields } } };
    };
    return { gql, sent };
  };

  it("throws and sends no mutation when more fields exist than were read", async () => {
    const p = readOnly({ pageInfo: { hasNextPage: true }, nodes: [{ name: "Status" }] });
    await expect(ensureFields(p.gql, "octo-org", 2)).rejects.toThrow(/fields/);
    expect(p.sent.some((q) => q.includes("mutation"))).toBe(false);
  });

  it("throws and sends no mutation when the field list is not an array", async () => {
    const p = readOnly({ pageInfo: { hasNextPage: false } });
    await expect(ensureFields(p.gql, "octo-org", 2)).rejects.toThrow(/fields/);
    await expect(setupStatus(p.gql, "octo-org", 2)).rejects.toThrow(/fields/);
    expect(p.sent.some((q) => q.includes("mutation"))).toBe(false);
  });
});
