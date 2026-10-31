import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { onSendAsyncHookHandler } from "fastify";

/** A smaller body is sent as is: compressing it saves little and costs a round of CPU. */
export const COMPRESS_MIN_BYTES = 8192;

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const COMPRESSIBLE = ["text/", "application/json", "application/manifest+json", "image/svg+xml"];

/** The encoding to answer with, brotli over gzip, or null. A q of 0 and unknown tokens are skipped. */
export function pickEncoding(acceptEncoding: string | string[] | undefined): "br" | "gzip" | null {
  if (acceptEncoding === undefined) return null;
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding;
  const accepted = new Set<string>();
  for (const part of header.split(",")) {
    const [token = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q !== undefined && !(Number.parseFloat(q.slice(2)) > 0)) continue;
    accepted.add(token.trim());
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

/** Hashed assets never change: their compressed bytes are kept, so each is compressed once. */
const immutableMemo = new Map<string, Buffer>();
const IMMUTABLE_MEMO_MAX = 64;

/** Compresses a large text response when the client accepts it. Streams (SSE) never reach it. */
export const compressResponse: onSendAsyncHookHandler = async (req, reply, payload) => {
  if (req.method === "HEAD") return payload;
  if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
  if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) return payload;
  if (reply.hasHeader("content-encoding")) return payload;
  const cacheControl = String(reply.getHeader("cache-control") ?? "");
  if (cacheControl.includes("no-transform")) return payload;
  const type = String(reply.getHeader("content-type") ?? "").toLowerCase();
  if (!COMPRESSIBLE.some((t) => type.startsWith(t))) return payload;
  const encoding = pickEncoding(req.headers["accept-encoding"]);
  if (encoding === null) return payload;

  const memoKey = cacheControl.includes("immutable")
    ? `${encoding} ${req.url} ${Buffer.byteLength(payload)}`
    : null;
  let body = memoKey === null ? undefined : immutableMemo.get(memoKey);
  if (body === undefined) {
    body =
      encoding === "br"
        ? await brotli(payload, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
        : await gz(payload);
    if (memoKey !== null) {
      if (immutableMemo.size >= IMMUTABLE_MEMO_MAX) immutableMemo.clear();
      immutableMemo.set(memoKey, body);
    }
  }
  reply.header("content-encoding", encoding);
  const vary = String(reply.getHeader("vary") ?? "");
  if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary))
    reply.header("vary", vary === "" ? "accept-encoding" : `${vary}, accept-encoding`);
  reply.removeHeader("content-length");
  return body;
};
