import type {
  AttentionItem,
  AttentionMaterialImage,
  AttentionMaterials,
  AttentionMaterialsResponse,
  AttentionStorySection,
  BriefOption,
  TicketHistory,
} from "@mc/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError } from "../api.ts";
import { useTz } from "../clock.ts";
import { Markdown } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { raisedAt, shortSha } from "../fmt.ts";
import { followLink, ticketPath } from "../router.ts";
import { useOverlay, useReturnFocus } from "../shell/overlays.ts";
import {
  chooserImages,
  defaultImageIndex,
  didScreenshots,
  imageLabel,
  isRelativeReference,
  mainTicket,
  packetImage,
  planSection,
  retainedImageId,
  type StoryImage,
  sectionImages,
} from "./materials.ts";
import { PICTURE_FAILED, useSource } from "./Pictures.tsx";
import { pictureRoute } from "./pictures.ts";

/** One picture the viewer can step to. */
export interface ViewImage {
  url: string;
  label: string;
}

/** Opens the viewer on picture `index` of `group`; the group is what the arrow keys step through. */
export type OpenViewer = (group: ViewImage[], index: number) => void;

export const NO_PLAN_TEXT = "This ticket has no Plan section.";
export const NO_MATERIALS_TEXT = "No pictures are attached to this question.";

/** The viewer for every picture of one question, mounted once so option pictures can open it too. */
export function useImageViewer(): { open: OpenViewer; element: ReactNode } {
  const [state, setState] = useState<{ group: ViewImage[]; index: number } | null>(null);
  return {
    open: (group, index) => setState({ group, index }),
    element: state && (
      <ImageViewer
        group={state.group}
        index={state.index}
        onIndex={(index) => setState({ ...state, index })}
        onClose={() => setState(null)}
      />
    ),
  };
}

function ImageViewer({
  group,
  index,
  onIndex,
  onClose,
}: {
  group: ViewImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const current = group[index];
  const route = current ? pictureRoute(current.url) : null;
  const [attempt, setAttempt] = useState(0);
  const [actual, setActual] = useState(false);
  const [broken, setBroken] = useState(false);
  useOverlay("material-viewer", true, onClose);
  useReturnFocus(true);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another picture starts clean
  useEffect(() => {
    setBroken(false);
    setAttempt(0);
  }, [index]);
  if (!current || !route) return null;
  return (
    <ViewerBody
      key={current.url}
      group={group}
      index={index}
      current={current}
      route={route}
      attempt={attempt}
      onRetry={() => {
        setBroken(false);
        setAttempt(attempt + 1);
      }}
      actual={actual}
      onActual={setActual}
      broken={broken}
      onBroken={() => setBroken(true)}
      onIndex={onIndex}
      onClose={onClose}
      closeRef={close}
    />
  );
}

function ViewerBody(p: {
  group: ViewImage[];
  index: number;
  current: ViewImage;
  route: NonNullable<ReturnType<typeof pictureRoute>>;
  attempt: number;
  onRetry: () => void;
  actual: boolean;
  onActual: (v: boolean) => void;
  broken: boolean;
  onBroken: () => void;
  onIndex: (i: number) => void;
  onClose: () => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const source = useSource(p.route, p.attempt);
  const failed = source.state === "failed" || p.broken;
  const last = p.group.length - 1;
  const step = (d: number) => p.onIndex(Math.min(last, Math.max(0, p.index + d)));
  return (
    <div
      className="mat-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Picture: ${p.current.label}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        }
      }}
    >
      <div className="mat-viewer-bar">
        <b className="mat-viewer-title">{p.current.label}</b>
        {p.group.length > 1 && (
          <>
            <span className="note" aria-live="polite">
              {p.index + 1} of {p.group.length}
            </span>
            <button type="button" className="sm" disabled={p.index === 0} onClick={() => step(-1)}>
              Previous
            </button>
            <button
              type="button"
              className="sm"
              disabled={p.index === last}
              onClick={() => step(1)}
            >
              Next
            </button>
          </>
        )}
        <button
          type="button"
          className="sm ghost"
          aria-pressed={p.actual}
          onClick={() => p.onActual(!p.actual)}
        >
          {p.actual ? "Fit width" : "Actual size"}
        </button>
        <button type="button" className="sm" ref={p.closeRef} onClick={p.onClose}>
          Close
        </button>
      </div>
      <div className={p.actual ? "mat-viewer-frame actual" : "mat-viewer-frame"}>
        {failed ? (
          <p className="note" role="alert">
            {PICTURE_FAILED}{" "}
            <button type="button" className="sm" onClick={p.onRetry}>
              Retry
            </button>
          </p>
        ) : source.state === "loading" ? (
          <p className="note" role="status">
            Loading the picture…
          </p>
        ) : (
          <img
            className="mat-viewer-img"
            src={source.src}
            alt={p.current.label}
            onError={p.onBroken}
          />
        )}
      </div>
    </div>
  );
}

/** A picture in the page: fits the column; a click opens it full size in the viewer. */
function Thumb({
  image,
  group,
  index,
  open,
}: {
  image: ViewImage;
  group: ViewImage[];
  index: number;
  open: OpenViewer;
}) {
  const route = pictureRoute(image.url);
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const source = useSource(route ?? { path: "", auth: "operator" }, attempt);
  if (!route) return <p className="note">The hub does not serve this picture.</p>;
  if (source.state === "failed" || broken)
    return (
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
    );
  if (source.state === "loading")
    return (
      <p className="note" role="status">
        Loading the picture…
      </p>
    );
  return (
    <button
      type="button"
      className="mat-thumb"
      aria-label={`Open ${image.label} full size`}
      onClick={() => open(group, index)}
    >
      <img
        className="mat-thumb-img"
        src={source.src}
        alt={image.label}
        onError={() => setBroken(true)}
      />
    </button>
  );
}

const asView = (i: StoryImage): ViewImage => ({ url: i.image.url, label: i.caption });

function Section({
  packet,
  section,
  depth,
  open,
}: {
  packet: AttentionMaterials;
  section: AttentionStorySection;
  depth: number;
  open: OpenViewer;
}) {
  const images = sectionImages(packet, section);
  const group = images.map(asView);
  const Heading = (["h4", "h5", "h6"] as const)[Math.min(depth, 2)] as "h4";
  return (
    <section className="mat-section" data-depth={depth}>
      <Heading className="mat-heading">{section.heading}</Heading>
      {section.text.trim() !== "" && <Markdown text={section.text} />}
      {images.length > 0 && (
        <div
          className={section.comparison ? "mat-compare" : "mat-images"}
          data-comparison={section.comparison ?? undefined}
          style={
            section.comparison
              ? { gridTemplateColumns: `repeat(${Math.min(images.length, 3)}, minmax(0, 1fr))` }
              : undefined
          }
        >
          {images.map((img, i) => (
            <figure className="mat-fig" key={img.image.id}>
              <figcaption>{img.caption}</figcaption>
              <Thumb image={asView(img)} group={group} index={i} open={open} />
            </figure>
          ))}
        </div>
      )}
      {section.children.map((child, i) => (
        <Section
          // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id and never reorder
          key={i}
          packet={packet}
          section={child}
          depth={depth + 1}
          open={open}
        />
      ))}
    </section>
  );
}

/** A plan packet's pictures: one at a time with a labelled chooser, so seventeen do not stack. */
function Chooser({ images, open }: { images: AttentionMaterialImage[]; open: OpenViewer }) {
  const [picked, setPicked] = useState<number | null>(null);
  if (images.length === 0) return null;
  const at = picked ?? defaultImageIndex(images);
  const group = images.map((i) => ({ url: i.url, label: imageLabel(i) }));
  return (
    <div className="mat-chooser">
      {/* biome-ignore lint/a11y/useSemanticElements: the group labels toggle buttons, not form fields */}
      <div className="mat-chooser-list" role="group" aria-label="Pictures in this packet">
        {images.map((img, i) => (
          <button
            type="button"
            key={img.id}
            className="sm"
            aria-pressed={i === at}
            onClick={() => setPicked(i)}
          >
            {imageLabel(img)}
          </button>
        ))}
      </div>
      <figure className="mat-fig" key={images[at]?.id}>
        <figcaption>
          {imageLabel(images[at] as AttentionMaterialImage)}
          <span className="note">
            {" "}
            · {at + 1} of {images.length}
          </span>
        </figcaption>
        <Thumb image={group[at] as ViewImage} group={group} index={at} open={open} />
      </figure>
    </div>
  );
}

/** A long plan scrolls in place; the keyboard can focus it to scroll it. */
function PlanScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a scrollable region is named and focusable on purpose
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll a long plan by focusing it
    <div className="mat-plan" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

const REASON_TEXT: Record<string, string> = {
  rebriefed: "the question was briefed again since",
  "source changed": "the source changed since",
  "question closed": "the question has closed",
  "repository changed": "the item moved to another repository",
};

function Packet({
  packet,
  open,
  tz,
}: {
  packet: AttentionMaterials;
  open: OpenViewer;
  tz: string | null;
}) {
  const stored = tz ? raisedAt(packet.registeredAt, tz) : "—";
  const inPlan = (url: string) => retainedImageId(url) !== null;
  const group = chooserImages(packet).map((i) => ({ url: i.url, label: imageLabel(i) }));
  const planImages = packet.story === null ? chooserImages(packet) : [];
  return (
    <article className="mat-packet" aria-label={packet.label}>
      <header className="mat-meta">
        <b>{packet.label}</b>
        <span className="note">
          {" "}
          · {packet.sourcePath ?? "story"} at {shortSha(packet.sourceCommit)} · kept {stored}
        </span>
        {packet.historical && (
          <span className="note" role="note">
            {" "}
            · Historical: {REASON_TEXT[packet.historicalReason ?? ""] ?? "no longer current"}
          </span>
        )}
      </header>
      {packet.story ? (
        packet.story.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id and never reorder
          <Section key={i} packet={packet} section={s} depth={0} open={open} />
        ))
      ) : (
        <>
          <PlanScroll label={`${packet.label} plan`}>
            <Markdown
              text={packet.markdown}
              renderLink={(url, label, image) => {
                if (inPlan(url)) {
                  const id = retainedImageId(url) as string;
                  const found = packetImage(packet, id);
                  const at = group.findIndex((g) => g.url === url);
                  if (!found || at < 0) return <span>{label} (picture unavailable)</span>;
                  return (
                    <button type="button" className="linklike" onClick={() => open(group, at)}>
                      {image ? "Picture: " : ""}
                      {label}
                    </button>
                  );
                }
                if (isRelativeReference(url))
                  return (
                    <span title={url}>
                      {label} <span className="note">(not attached to this question)</span>
                    </span>
                  );
                return undefined;
              }}
            />
          </PlanScroll>
          <Chooser images={planImages} open={open} />
        </>
      )}
    </article>
  );
}

/** The picture(s) of a brief option, on the option itself. */
export function OptionPictures({
  option,
  packets,
  open,
}: {
  option: BriefOption;
  packets: AttentionMaterials[];
  open: OpenViewer;
}) {
  const live = packets.filter((p) => !p.historical).at(-1);
  const ids = live?.optionImages.find((o) => o.optionId === option.id)?.imageIds ?? [];
  if (!live || option.id === undefined || ids.length === 0) return null;
  const images = ids.flatMap((id) => {
    const i = packetImage(live, id);
    return i ? [{ url: i.url, label: imageLabel(i) }] : [];
  });
  return (
    <div className="mat-option-pics">
      {images.map((img, i) => (
        <figure className="mat-fig" key={img.url}>
          <figcaption>{img.label}</figcaption>
          <Thumb image={img} group={images} index={i} open={open} />
        </figure>
      ))}
    </div>
  );
}

/** What the retained packets of the open item are; the 404 of an item with none is not an error. */
export function useAttentionMaterials(item: AttentionItem | null): {
  packets: AttentionMaterials[];
  loading: boolean;
  error: Error | null;
} {
  const res = useResource<AttentionMaterialsResponse>(
    item ? RESOURCES.attentionMaterials(item.key) : null,
  );
  const none = res.error instanceof ApiError && res.error.status === 404;
  return {
    packets: res.data?.packets ?? [],
    loading: item !== null && res.data === undefined && !res.error,
    error: res.error && !none ? res.error : null,
  };
}

function MainPlan({ item }: { item: AttentionItem }) {
  const ref = mainTicket(item);
  const res = useResource<TicketHistory>(
    ref ? RESOURCES.ticketHistory(ref.repoId, ref.number) : null,
  );
  if (!ref) return null;
  const t = res.data;
  const matches = t !== undefined && t.repoId === ref.repoId && t.number === ref.number;
  const name = `${ref.repoId}#${ref.number}`;
  if (!matches)
    return res.error ? (
      <p className="note" role="status">
        Could not load the plan of {name}: {res.error.message}{" "}
        <button
          type="button"
          className="sm"
          onClick={() => hub.refetch(RESOURCES.ticketHistory(ref.repoId, ref.number).path)}
        >
          Retry loading the plan
        </button>
      </p>
    ) : (
      <p className="note" role="status">
        Loading the plan of {name}…
      </p>
    );
  if (t.githubError !== null || t.body === null)
    return (
      <p className="note" role="status">
        The plan of {name} could not be read from GitHub{t.githubError ? `: ${t.githubError}` : ""}.
      </p>
    );
  const plan = planSection(t.body);
  return (
    <section className="mat-main-plan">
      <h4 className="mat-heading">
        Plan of {name}: {t.title}
      </h4>
      {plan === null ? (
        <p className="note">
          {NO_PLAN_TEXT}{" "}
          <a
            href={ticketPath(ref.repoId, ref.number)}
            onClick={(e) => followLink(e, ticketPath(ref.repoId, ref.number))}
          >
            Open the full ticket
          </a>
        </p>
      ) : (
        <PlanScroll label={`Plan of ${name}`}>
          <Markdown text={plan} />
        </PlanScroll>
      )}
      {t.bodyTruncated && (
        <p className="note">
          The ticket text was cut, so the plan may be incomplete.{" "}
          <a href={t.url} target="_blank" rel="noopener noreferrer">
            Continue on GitHub
          </a>
        </p>
      )}
    </section>
  );
}

/** Screenshots the brief's work recorded: a live "before" the change, never the proposal. */
function LiveBefore({ item, open }: { item: AttentionItem; open: OpenViewer }) {
  const shots = didScreenshots(item);
  if (shots.length === 0) return null;
  return (
    <div className="mat-live">
      <h4 className="mat-heading">Live now (recorded by the work, not the proposal)</h4>
      <div className="mat-images">
        {shots.map((s, i) => (
          <figure className="mat-fig" key={s.url}>
            <figcaption>{s.label}</figcaption>
            <Thumb image={s} group={shots} index={i} open={open} />
          </figure>
        ))}
      </div>
    </div>
  );
}

/**
 * The complete relevant plan and the proposal's pictures, inside the open question. Reading only:
 * nothing here chooses, answers or acknowledges.
 */
export function PlanAndMockups({
  item,
  packets,
  loading,
  error,
  open,
}: {
  item: AttentionItem;
  packets: AttentionMaterials[];
  loading: boolean;
  error: Error | null;
  open: OpenViewer;
}) {
  const tz = useTz();
  const shots = didScreenshots(item).length > 0;
  const ref = mainTicket(item);
  if (!ref && packets.length === 0 && !loading && !error && !shots) return null;
  return (
    <section className="mat" aria-label="Plan and mockups">
      <h3 className="bsec">Plan and mockups</h3>
      {loading && (
        <p className="note" role="status">
          Loading the attached materials…
        </p>
      )}
      {error && (
        <p className="note" role="status">
          Could not load the attached materials: {error.message}
        </p>
      )}
      {packets.map((p) => (
        <Packet key={p.id} packet={p} open={open} tz={tz} />
      ))}
      {!loading && !error && packets.length === 0 && <p className="note">{NO_MATERIALS_TEXT}</p>}
      <MainPlan item={item} />
      <LiveBefore item={item} open={open} />
    </section>
  );
}
