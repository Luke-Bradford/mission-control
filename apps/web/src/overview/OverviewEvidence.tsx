import {
  forwardRef,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useOverlay } from "../shell/overlays.ts";

export interface EvidenceReader {
  show: () => void;
}

/** The same reader becomes an inline investigation panel when there is real vertical capacity.
 * Opening it mounts existing cached resources, never a second collection or a separate poll.
 * A native modal keeps nested readers above FLIGHT's inert page and restores its invoking control.
 */
export const OverviewEvidence = forwardRef<
  EvidenceReader,
  { title: string; children: ReactNode; inlineQuery?: string; inline?: boolean; className?: string }
>(function OverviewEvidence(
  { title, children, inlineQuery, inline: controlledInline, className = "" },
  ref,
) {
  const id = useId(),
    dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | null>(null),
    isModal = useRef(false);
  const [modal, setModal] = useState(false),
    [queryInline, setInline] = useState(false),
    [visited, setVisited] = useState(false);
  const inline = controlledInline ?? queryInline;
  const close = () => setModal(false);
  useOverlay(`overview-evidence-${id}`, modal, close);
  useEffect(() => {
    if (!inlineQuery || typeof matchMedia === "undefined") return;
    const query = matchMedia(inlineQuery),
      update = () => setInline(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [inlineQuery]);
  useImperativeHandle(
    ref,
    () => ({
      show() {
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setVisited(true);
        if (inline) {
          dialog.current?.scrollIntoView({ block: "start" });
          dialog.current?.querySelector<HTMLElement>(".evidence-body")?.focus();
        } else setModal(true);
      },
    }),
    [inline],
  );
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (modal) {
      if (!isModal.current) {
        if (element.open) element.close();
        element.showModal();
        isModal.current = true;
      }
    } else {
      if (element.open) element.close();
      isModal.current = false;
      if (inline) element.open = true;
    }
  }, [modal, inline]);
  useEffect(() => {
    const element = dialog.current;
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  useEffect(() => {
    if (modal)
      return () => {
        const control = opener.current;
        // The opener can be in FLIGHT, another native reader, or the inline page.
        requestAnimationFrame(() => {
          const active = document.activeElement;
          const lost =
            active === document.body ||
            !active?.isConnected ||
            !!active.closest("[hidden], dialog:not([open])");
          // Native close may already have restored focus, or the user moved on.
          if (lost && control?.isConnected) control.focus();
        });
      };
  }, [modal]);
  return (
    <dialog
      ref={dialog}
      className={`overview-evidence ${className}${inline && !modal ? " evidence-inline" : ""}`}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="evidence-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" onClick={close}>
          Close
        </button>
      </header>
      <section
        className="evidence-body scroll"
        aria-label={title}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this named bounded complete reader supports native keyboard scrolling.
        tabIndex={0}
      >
        {(inline || visited) && children}
      </section>
    </dialog>
  );
});
