import type { PillTone } from "@mc/core";
import type { AriaRole, ButtonHTMLAttributes, ReactNode } from "react";
import "./Pill.css";

/**
 * A dot plus a word, never colour alone (mockup L110–115): `ok` green, `warn` amber, `crit` red,
 * `neutral` grey with a dot (Idle, Stopped, CI pending…), `plain` grey without one (Draft, Closed…).
 */
export function Pill({
  tone,
  title,
  className,
  role,
  children,
}: {
  tone: PillTone;
  title?: string;
  className?: string;
  role?: AriaRole;
  children: ReactNode;
}) {
  return (
    <span className={`pill ${tone}${className ? ` ${className}` : ""}`} title={title} role={role}>
      {children}
    </span>
  );
}

/** A pill that is a control: the same dot-and-word look, rendered as a button (`kyou`, a Needs-you action). */
export function PillButton({
  tone,
  className,
  children,
  ...rest
}: { tone: PillTone; className?: string; children: ReactNode } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "type"
>) {
  return (
    <button type="button" className={`pill ${tone}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </button>
  );
}
