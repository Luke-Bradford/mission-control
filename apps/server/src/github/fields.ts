export const singleSelectField = (
  alias: string,
  name: string,
  value: "name" | "optionId" = "name",
): string =>
  `${alias}: fieldValueByName(name: "${name}") { ... on ProjectV2ItemFieldSingleSelectValue { ${value} } }`;

export const projectFields = (ids: boolean): string => {
  const fields = ids ? "id name" : "name";
  return `... on ProjectV2FieldCommon { ${fields} }
... on ProjectV2SingleSelectField { options { ${fields} } }`;
};
