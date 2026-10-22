import type { HudLampKind } from "@mc/core";

/**
 * A status lamp. Colour is never the only signal: each kind has its own shape (warn diamond, crit
 * square, ok circle, off ring) and the label is its accessible name. `pulse` breathes (amber waits
 * on you, green is being worked); reduced motion turns the breath into a still ring.
 */
export function Lamp({
  kind,
  pulse = false,
  label,
  title,
  decorative = false,
}: {
  kind: HudLampKind;
  pulse?: boolean;
  label: string;
  /** Defaults to the label; `false` sets none, for a lamp inside something that has its own title. */
  title?: string | false;
  /** The state's word is right beside it: hide the lamp from screen readers so it is read once. */
  decorative?: boolean;
}) {
  const cls = `lamp ${kind}${pulse ? " pulse" : ""}`;
  const tip = title === false ? undefined : (title ?? label);
  if (decorative) return <span className={cls} aria-hidden="true" title={tip} />;
  return <span className={cls} role="img" aria-label={label} title={tip} />;
}
