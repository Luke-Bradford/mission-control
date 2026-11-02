export const date = (value: number | null) =>
  value === null
    ? "Not observed"
    : `${new Date(value).toLocaleString("en-GB", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      })} UTC`;
export const label = (value: string) => value.replaceAll("-", " ");
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed. Retry after refreshing evidence.";
