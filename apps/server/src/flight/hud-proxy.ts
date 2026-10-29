/**
 * A loopback-only egress proxy for the HUD screenshot browser. Chrome is pointed at it (and told
 * not to bypass it for loopback), so every request the browser makes, redirects, popups, workers
 * and subresources included, can only reach the hub: the one host:port in the configured origin.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface HudProxy {
  /** `host:port` of the proxy, for Chrome's --proxy-server. */
  readonly address: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The one `host:port` the proxy will connect to, or null when the hub is not on loopback. */
export function hubTarget(hubOrigin: string): { host: string; port: number } | null {
  const url = new URL(hubOrigin);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return {
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port || 80),
  };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether `host:port` (a CONNECT authority) names the hub. */
function allowedAuthority(authority: string, hub: { host: string; port: number }): boolean {
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return false;
  }
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  return same(host, hub.host) && Number(url.port || 80) === hub.port;
}

export async function startHudProxy(hubOrigin: string): Promise<HudProxy> {
  const hub = hubTarget(hubOrigin);
  const sockets = new Set<Socket | Duplex>();
  const track = (s: Socket | Duplex): void => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };

  const server: Server = createServer((req: IncomingMessage, res) => {
    // Plain HTTP proxying: the request line carries an absolute URI.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!hub || target.protocol !== "http:" || !allowedAuthority(target.host, hub)) {
      res.writeHead(403).end("HUD screenshot proxy: hub only");
      return;
    }
    const upstream = httpRequest(
      {
        host: hub.host,
        port: hub.port,
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    track(req.socket);
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, client: Duplex) => {
    track(client);
    client.on("error", () => client.destroy());
    if (!hub || !allowedAuthority(req.url ?? "", hub)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(hub.port, hub.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on("error", () => {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    address: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
