import {
  isObj,
  OWNER_FIELD,
  OWNERS,
  PRIORITIES,
  PRIORITY_FIELD,
  SIZE_FIELD,
  STAGE_FIELD,
  STAGES,
  STATUS_FIELD,
  TICKET_SIZES,
} from "@mc/core";
import type { Gql } from "./collectors/github.ts";
import { projectFields } from "./github-fields.ts";

type FieldName =
  | typeof STAGE_FIELD
  | typeof OWNER_FIELD
  | typeof PRIORITY_FIELD
  | typeof SIZE_FIELD;

export type SetupStatus = {
  projectId: string;
  missing: FieldName[];
  mismatched: { field: string; options: string[] }[];
};
export type SetupResult = { created: FieldName[]; mismatched: SetupStatus["mismatched"] };

interface FieldSpec {
  name: FieldName;
  options: { name: string; color: string }[];
}

/** The only fields this module may create, with the exact option sets (and colours) the board reads. */
const SPECS: FieldSpec[] = [
  {
    name: STAGE_FIELD,
    options: [
      { name: STAGES[0], color: "YELLOW" },
      { name: STAGES[1], color: "GREEN" },
    ],
  },
  {
    name: OWNER_FIELD,
    options: [
      { name: OWNERS[0], color: "PURPLE" },
      { name: OWNERS[1], color: "BLUE" },
      { name: OWNERS[2], color: "GRAY" },
      { name: OWNERS[3], color: "ORANGE" },
    ],
  },
  {
    name: PRIORITY_FIELD,
    options: [
      { name: PRIORITIES[0], color: "RED" },
      { name: PRIORITIES[1], color: "ORANGE" },
      { name: PRIORITIES[2], color: "YELLOW" },
    ],
  },
  { name: SIZE_FIELD, options: TICKET_SIZES.map((name) => ({ name, color: "BLUE" })) },
];

const FIELDS_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            ${projectFields(true)}
          }
        }
      }
    }
  }
}`;

// The mutations this module is allowed to send.
const CREATE_FIELD = `mutation($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { name } } }
}`;

const LABELS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    id
    existing: labels(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
}`;
const LABELS_MAX_PAGES = 20;

const CREATE_LABEL = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { label { name } }
}`;

const sameOptions = (have: string[], want: FieldSpec["options"]): boolean =>
  have.length === want.length && want.every((o) => have.includes(o.name));

interface ReadField {
  id: string | null;
  options: { id: string | null; name: string }[];
}

/** Reads the project's fields (name -> id and options); throws on a missing project or a gql failure. */
async function read(gql: Gql, owner: string, project: number) {
  const data = await gql(FIELDS_QUERY, { owner, number: project });
  const p = isObj(data) && isObj(data.repositoryOwner) ? data.repositoryOwner.projectV2 : null;
  if (!isObj(p) || typeof p.id !== "string") {
    throw new Error(`github: project ${project} not found for ${owner}`);
  }
  // Fail closed: a field this read could not see must never be mistaken for a missing one.
  const f = p.fields;
  if (
    !isObj(f) ||
    !Array.isArray(f.nodes) ||
    !isObj(f.pageInfo) ||
    f.pageInfo.hasNextPage !== false
  ) {
    throw new Error(`github: could not read all fields of project ${project}`);
  }
  const nodes: unknown[] = f.nodes;
  const fields = new Map<string, ReadField>();
  for (const n of nodes) {
    if (!isObj(n) || typeof n.name !== "string") continue;
    const options = Array.isArray(n.options)
      ? n.options.flatMap((o) =>
          isObj(o) && typeof o.name === "string"
            ? [{ id: typeof o.id === "string" ? o.id : null, name: o.name }]
            : [],
        )
      : [];
    fields.set(n.name, { id: typeof n.id === "string" ? n.id : null, options });
  }
  return { projectId: p.id, fields };
}

export async function setupStatus(gql: Gql, owner: string, project: number): Promise<SetupStatus> {
  const { projectId, fields } = await read(gql, owner, project);
  const missing: FieldName[] = [];
  const mismatched: SetupStatus["mismatched"] = [];
  for (const spec of SPECS) {
    const have = fields.get(spec.name)?.options.map((o) => o.name);
    if (have === undefined) missing.push(spec.name);
    else if (!sameOptions(have, spec.options)) mismatched.push({ field: spec.name, options: have });
  }
  return { projectId, missing, mismatched };
}

/** The project's Status field with the ids a card move needs; throws when it or an id is missing. */
export async function readStatusField(
  gql: Gql,
  owner: string,
  project: number,
  fieldName: string = STATUS_FIELD,
): Promise<{ projectId: string; fieldId: string; options: { id: string; name: string }[] }> {
  const { projectId, fields } = await read(gql, owner, project);
  const status = fields.get(fieldName);
  const options = (status?.options ?? []).flatMap((o) =>
    o.id === null ? [] : [{ id: o.id, name: o.name }],
  );
  if (status === undefined || status.id === null || options.length !== status.options.length) {
    throw new Error(`github: project ${project} has no ${fieldName} field with option ids`);
  }
  return { projectId, fieldId: status.id, options };
}

/**
 * Creates only the missing Stage/Owner/Priority/Size fields. A field that exists with other
 * options (or of another type) is reported and left alone. Throws on the first failure; fields
 * created before it are not reported, and the next call finds them present.
 */
export async function ensureFields(gql: Gql, owner: string, project: number): Promise<SetupResult> {
  const { projectId, missing, mismatched } = await setupStatus(gql, owner, project);
  const created: FieldName[] = [];
  for (const spec of SPECS.filter((s) => missing.includes(s.name))) {
    await gql(CREATE_FIELD, {
      input: {
        projectId,
        dataType: "SINGLE_SELECT",
        name: spec.name,
        singleSelectOptions: spec.options.map((o) => ({ ...o, description: "" })),
      },
    });
    created.push(spec.name);
  }
  return { created, mismatched };
}

/**
 * Reads the repository's id and every label name (lower-cased: GitHub compares them without
 * case). Fails closed: a label list it could not read in full must never read as missing labels.
 */
async function readLabels(gql: Gql, owner: string, name: string) {
  const have = new Set<string>();
  let id: string | null = null;
  let after: string | null = null;
  for (let page = 0; page < LABELS_MAX_PAGES; page++) {
    const data = await gql(LABELS_QUERY, { owner, name, after });
    const r = isObj(data) ? data.repository : null;
    if (!isObj(r) || typeof r.id !== "string") {
      throw new Error(`github: repository ${owner}/${name} not found`);
    }
    id = r.id;
    const l = r.existing;
    if (!isObj(l) || !Array.isArray(l.nodes) || !isObj(l.pageInfo)) {
      throw new Error(`github: could not read the labels of ${owner}/${name}`);
    }
    for (const n of l.nodes as unknown[]) {
      if (isObj(n) && typeof n.name === "string") have.add(n.name.toLowerCase());
    }
    if (l.pageInfo.hasNextPage === false) return { id, have };
    if (typeof l.pageInfo.endCursor !== "string") break;
    after = l.pageInfo.endCursor;
  }
  throw new Error(`github: could not read all labels of ${owner}/${name}`);
}

/** The names in `labels` the repository (`owner/name`) lacks; throws when it cannot read them all. */
export async function missingLabels(
  gql: Gql,
  repo: string,
  labels: readonly { name: string }[],
): Promise<string[]> {
  const [owner = "", name = ""] = repo.split("/");
  const { have } = await readLabels(gql, owner, name);
  return labels.map((l) => l.name).filter((n) => !have.has(n.toLowerCase()));
}

/**
 * Creates the labels the repository (`owner/name`) lacks and returns those it created. Throws on
 * the first failure; labels created before it are not reported, and the next call finds them.
 */
export async function ensureLabels(
  gql: Gql,
  repo: string,
  labels: readonly { name: string; color: string }[],
): Promise<string[]> {
  const [owner = "", name = ""] = repo.split("/");
  const { id, have } = await readLabels(gql, owner, name);
  const created: string[] = [];
  for (const label of labels) {
    if (have.has(label.name.toLowerCase())) continue;
    await gql(CREATE_LABEL, {
      input: { repositoryId: id, name: label.name, color: label.color },
    });
    created.push(label.name);
  }
  return created;
}
