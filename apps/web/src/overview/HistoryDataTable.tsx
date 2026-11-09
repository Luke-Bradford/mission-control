import { useTz } from "../clock.ts";
import { hhmm } from "../fmt.ts";

/** The same loaded observations, readable with a keyboard; never reconstruct absent readings. */
export function HistoryDataTable({
  values,
  format,
  unit,
  at,
}: {
  values: (number | null)[];
  format: (value: number) => string;
  unit: string;
  at: number;
}) {
  const tz = useTz(),
    end = Math.floor(at / 60_000) * 60_000;
  return (
    <details className="history-data">
      <summary>Recorded values · {values.length} points</summary>
      <section
        className="history-data-scroll scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this named bounded evidence table supports keyboard scrolling.
        tabIndex={0}
        aria-label={`Recorded ${unit} observations`}
      >
        <p className="s muted">
          {`Complete minutes${tz ? ` · ${tz}` : ""}`} · Scroll ↕ for every observation.
        </p>
        <table>
          <thead>
            <tr>
              <th>Minute starting</th>
              <th className="num">Display · {unit}</th>
              <th className="num">Recorded · {unit}</th>
            </tr>
          </thead>
          <tbody>
            {values.map((value, index) => {
              const timestamp = end - (values.length - index) * 60_000;
              const key = String(timestamp);
              return (
                <tr key={key}>
                  <th scope="row">{tz ? hhmm(timestamp, tz) : `−${values.length - index}m`}</th>
                  <td className="num">{value === null ? "Not collected" : format(value)}</td>
                  <td className="num">{value === null ? "—" : String(value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </details>
  );
}
