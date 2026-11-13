import { lazy, Suspense, useCallback, useState } from "react";
import {
  AUDIT_VIEWS,
  AuditOverview,
  type AuditScope,
  type AuditViewName,
} from "../code-health/AuditOverview.tsx";
import { CodeHealth } from "../code-health/CodeHealth.tsx";

const Legacy = lazy(() => import("./LegacyAudit.tsx").then((m) => ({ default: m.LegacyAudit })));

/** `/audit?tab=` names a view; an unknown or missing one opens the overview. */
function viewFromUrl(): AuditViewName {
  const tab = new URLSearchParams(globalThis.window.location.search).get("tab");
  return AUDIT_VIEWS.find((v) => v.value === tab)?.value ?? "overview";
}

/** The Audit page: the approved overview first, every earlier view one click away. */
export function Audit() {
  const [view, setView] = useState<AuditViewName>(viewFromUrl);
  const [scope, setScope] = useState<AuditScope>({ repo: "", window: "30d" });
  const back = useCallback((next?: AuditScope) => {
    if (next) setScope(next);
    setView("overview");
  }, []);
  if (view === "overview")
    return <AuditOverview scope={scope} onScope={setScope} onOpen={setView} />;
  if (view === "history")
    return (
      <section id="page-audit" className="code-health">
        <div className="ch-heading">
          <div>
            <h1>Audit</h1>
            <p>Workflow history and earlier proposals</p>
          </div>
          <button type="button" onClick={() => back()}>
            Back to overview
          </button>
        </div>
        <Suspense fallback={<p>Loading workflow history…</p>}>
          <Legacy />
        </Suspense>
      </section>
    );
  return <CodeHealth initialTab={view} initialScope={scope} onBack={back} />;
}
