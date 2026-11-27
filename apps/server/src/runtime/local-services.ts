/** Hub-owned Unix sockets that proxy a repo's explicitly configured loopback services. */
import { existsSync, lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

const LOCAL_SERVICE = /^127\.0\.0\.1:(\d+)$/;

/** PostgreSQL discovers a Unix socket as `.s.PGSQL.<port>` below PGHOST. */
export function localServiceSocketPath(dir: string, service: string): string {
  const match = LOCAL_SERVICE.exec(service);
  if (match === null) throw new Error(`invalid local service: ${service}`);
  return join(dir, `.s.PGSQL.${match[1]}`);
}

export interface LocalServiceForwards {
  readonly sockets: readonly string[];
  close(): Promise<void>;
}

/**
 * Starts one Unix socket per configured service. The directory must be private to the hub: a seat
 * gets permission to connect to these exact paths, not permission to replace them.
 */
export function startLocalServiceForwards(
  services: readonly string[],
  dir: string,
): LocalServiceForwards {
  if (services.length === 0) return { sockets: [], close: async () => {} };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("local service socket folder must be a private directory owned by the server");

  const servers: Server[] = [];
  const clients = new Set<Socket>();
  const sockets = services.map((service) => localServiceSocketPath(dir, service));
  try {
    for (let at = 0; at < services.length; at += 1) {
      const service = services[at];
      const socketPath = sockets[at];
      if (service === undefined || socketPath === undefined)
        throw new Error("missing local service");
      if (existsSync(socketPath)) unlinkSync(socketPath);
      const port = Number(LOCAL_SERVICE.exec(service)?.[1]);
      const server = createServer((client) => {
        const upstream = connect({ host: "127.0.0.1", port });
        clients.add(client);
        clients.add(upstream);
        client.pipe(upstream).pipe(client);
        client.on("close", () => clients.delete(client));
        upstream.on("close", () => clients.delete(upstream));
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
      });
      server.listen(socketPath);
      servers.push(server);
    }
  } catch (error) {
    void closeLocalServiceForwards(servers, clients, sockets, dir);
    throw error;
  }
  return {
    sockets,
    close: () => closeLocalServiceForwards(servers, clients, sockets, dir),
  };
}

async function closeLocalServiceForwards(
  servers: readonly Server[],
  clients: ReadonlySet<Socket>,
  sockets: readonly string[],
  dir?: string,
): Promise<void> {
  for (const client of clients) client.destroy();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const socket of sockets) rmSync(socket, { force: true });
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
}
