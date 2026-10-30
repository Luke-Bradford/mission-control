import type { PillTone } from "@mc/core";
import type { AriaRole, ReactNode } from "react";
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
