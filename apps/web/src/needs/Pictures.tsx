import type { AttentionItem } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiOperatorPicture } from "../api.ts";
import { briefPictures, type PictureRoute, pictureRoute } from "./pictures.ts";

export const PICTURE_NOT_STORED =
  "This picture isn't stored on the hub, so it can't be shown here.";
export const PICTURE_FAILED = "This picture could not be loaded.";

/** The blob as a data URL: the CSP has no `blob:`, so an object URL would not load. */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("image"));
    reader.readAsDataURL(blob);
  });
}

type Source = { state: "loading" } | { state: "ready"; src: string } | { state: "failed" };

/** What to put in `src`: a hub route as it is, an operator route fetched with the token. */
function useSource(route: PictureRoute, attempt: number): Source {
  const [source, setSource] = useState<Source>(
    route.auth === "hub" ? { state: "ready", src: route.path } : { state: "loading" },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry is a new attempt
  useEffect(() => {
    if (route.auth === "hub") {
      setSource({ state: "ready", src: route.path });
      return;
    }
    let live = true;
    setSource({ state: "loading" });
    apiOperatorPicture(route.path)
      .then(dataUrl)
      .then((src) => live && setSource({ state: "ready", src }))
      .catch(() => live && setSource({ state: "failed" }));
    return () => {
      live = false;
    };
  }, [route.path, route.auth, attempt]);
  return source;
}

function Picture({ label, route }: { label: string; route: PictureRoute }) {
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const [actual, setActual] = useState(false);
  const source = useSource(route, attempt);
  const failed = source.state === "failed" || broken;
  const frame = useRef<HTMLDivElement>(null);
  return (
    <figure className="needs-picture">
      <figcaption>
        <b>{label}</b>
        {source.state === "ready" && !failed && (
          <button
            type="button"
            className="sm ghost"
            aria-pressed={actual}
            onClick={() => setActual(!actual)}
          >
            {actual ? "Fit width" : "Actual size"}
          </button>
        )}
      </figcaption>
      {failed ? (
        <p className="note" role="alert">
          {PICTURE_FAILED}{" "}
          <button
            type="button"
            className="sm"
            onClick={() => {
              setBroken(false);
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </button>
        </p>
      ) : source.state === "loading" ? (
        <p className="note" role="status">
          Loading the picture…
        </p>
      ) : (
        <div ref={frame} className={actual ? "needs-frame actual" : "needs-frame"}>
          <img src={source.src} alt={label} onError={() => setBroken(true)} />
        </div>
      )}
    </figure>
  );
}

/**
 * The item's pictures, large, in the main column. Only pictures the hub serves are loaded (see
 * `pictureRoute`); any other image is not requested, and its URL is a link in the Links section.
 */
export function Pictures({ item }: { item: AttentionItem }) {
  const pictures = briefPictures(item);
  if (pictures.length === 0) return null;
  return (
    <section className="needs-pictures" aria-label="Pictures">
      {pictures.map((p) => {
        const route = pictureRoute(p.url);
        return route ? (
          <Picture key={p.url} label={p.label} route={route} />
        ) : (
          <p className="note" key={p.url}>
            <b>{p.label}</b>: {PICTURE_NOT_STORED}
          </p>
        );
      })}
    </section>
  );
}
