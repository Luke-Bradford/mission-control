import { FLIGHT_NOT_RUNNING } from "@mc/core";
import { Decided } from "../flight/Decided.tsx";
import { Situation } from "../flight/Situation.tsx";
import { WorkInFlight } from "../flight/WorkInFlight.tsx";
import { Panel } from "../hud/Panel.tsx";

const Waiting = () => <p className="pb note">{FLIGHT_NOT_RUNNING}</p>;

/** FLIGHT (catalogue §2.2): the head agent's picture of the work. Its own panels wait for FLIGHT. */
export function Flight() {
  return (
    <section id="page-flight">
      <Situation />
      <Panel
        id="askP"
        title="Asked of you"
        sub="people waiting on a reply from you, with FLIGHT's take · first, because a person is waiting"
      >
        <Waiting />
      </Panel>
      <Panel
        id="wifP"
        title="Work in flight"
        sub="every ticket being worked, step by step · ×2 means a step ran twice"
      >
        <WorkInFlight />
      </Panel>
      <div className="fgrid">
        <Panel id="incP" title="Incoming" sub="what arrived and what FLIGHT did with it">
          <Waiting />
        </Panel>
        <Panel id="watchP" title="Watch list" sub="what FLIGHT is keeping an eye on">
          <Waiting />
        </Panel>
        <div className="col free">
          <Panel
            id="draftsP"
            title="Drafts for you to send"
            sub="Mission Control never messages people itself"
          >
            <Waiting />
          </Panel>
          <Panel id="decidedP" title="Decided without you" sub="today · overturn any">
            <Decided />
          </Panel>
        </div>
      </div>
    </section>
  );
}
