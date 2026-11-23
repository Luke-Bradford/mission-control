/** The one-off clean with no grace period: marked done only once a sweep has run to the end. */
export async function runFirstClean(
  setting: { get(): string | null; set(value: string): void },
  sweep: (graceMs?: number) => Promise<boolean>,
  now: () => number,
): Promise<void> {
  if (setting.get() === null) {
    if (await sweep(0)) setting.set(String(now()));
    return;
  }
  await sweep();
}
