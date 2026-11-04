/**
 * Opt-in pieces for the Setup agent, session and account forms: a named, focusable summary of what
 * stopped a save, per-field error wiring, and a guard against a second submit while one is out.
 * It carries no request, cache or authorisation logic: callers keep using apiPost/apiPut.
 */
import { type ReactNode, useEffect, useId, useRef } from "react";

/** One known local problem: the id of the field it belongs to, and what to tell the operator. */
export interface FieldIssue {
  id: string;
  message: string;
}

/** The id of the error line under field `id`. */
export const errorId = (id: string): string => `${id}-error`;

/**
 * The accessibility attributes of a field: invalid with a message below it, and described by its
 * hint and that message. Spread onto the input or select that has the `id`.
 */
export function fieldProps(id: string, error: string | undefined, hintId?: string) {
  const described = [hintId, error === undefined ? undefined : errorId(id)]
    .filter((x) => x !== undefined)
    .join(" ");
  return {
    id,
    "aria-invalid": error === undefined ? undefined : (true as const),
    "aria-describedby": described === "" ? undefined : described,
  };
}

/** The message under a field; nothing when the field is fine. */
export function FieldError({ id, error }: { id: string; error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <p id={errorId(id)} className="ferr crit-t xs">
      {error}
    </p>
  );
}

/** The first issue for a field id. */
export const issueOf = (issues: FieldIssue[], id: string): string | undefined =>
  issues.find((issue) => issue.id === id)?.message;

/**
 * What stopped the save: the known field problems (each a link that moves focus to its field)
 * and/or one form-level message from the server or the network, kept as the server wrote it.
 * Focus moves to it whenever `focusKey` changes to a non-zero value, and it scrolls into view.
 */
export function ErrorSummary({
  title,
  issues,
  message,
  focusKey,
  children,
}: {
  title: string;
  issues: FieldIssue[];
  message: string | null;
  focusKey: number;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const shown = issues.length > 0 || message !== null;
  useEffect(() => {
    if (focusKey === 0 || !shown) return;
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusKey, shown]);
  if (!shown) return null;
  return (
    <section ref={ref} className="fsum" tabIndex={-1} aria-labelledby={titleId}>
      <h3 id={titleId} className="fsum-title s">
        {title}
      </h3>
      {message !== null && (
        <p role="alert" className="crit-t s">
          {message}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="s">
          {issues.map((issue) => (
            <li key={`${issue.id}:${issue.message}`}>
              <a
                href={`#${issue.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const field = document.getElementById(issue.id);
                  field?.focus();
                  field?.scrollIntoView?.({ block: "nearest" });
                }}
              >
                {issue.message}
              </a>
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/**
 * True once, until `release()`: the first of two submits in the same tick (Enter then a click)
 * wins, before any re-render could disable the button.
 */
export function useSubmitGuard(): {
  take: () => boolean;
  release: () => void;
  pending: () => boolean;
} {
  const out = useRef(false);
  const api = useRef({
    take: () => {
      if (out.current) return false;
      out.current = true;
      return true;
    },
    release: () => {
      out.current = false;
    },
    pending: () => out.current,
  });
  return api.current;
}

/**
 * A failure that tells nothing about whether the server acted: the network dropped or the
 * server broke without saying why. Anything with a JSON refusal (400–409) is a clear "no".
 */
export const isUncertain = (status: number | undefined): boolean =>
  status === undefined || status >= 500;

export const UNCERTAIN_TEXT =
  "The result is unknown: the connection dropped or the server did not answer. Your entries are kept. Mission Control is rereading what is saved; check it before saving again.";
