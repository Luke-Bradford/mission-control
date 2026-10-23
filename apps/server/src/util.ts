export function str(v: unknown): string | null;
export function str(v: unknown, fallback: string): string;
export function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
