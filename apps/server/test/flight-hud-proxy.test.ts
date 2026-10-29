import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { hubTarget, startHudProxy } from "../src/flight/hud-proxy.ts";

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

async function hub(): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => res.end(`hub:${req.url}`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open.push({ close: () => server.closeAllConnections() }, { close: () => server.close() });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

function viaProxy(proxy: string, target: string): Promise<{ status: number; body: string }> {
  const [host, port] = proxy.split(":");
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port: Number(port), method: "GET", path: target }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectVia(proxy: string, authority: string): Promise<string> {
  const [host, port] = proxy.split(":");
  return new Promise((resolve) => {
    const s = connect(Number(port), host);
    let data = "";
    s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    s.on("data", (d) => {
      data += d;
      if (data.includes("\r\n\r\n")) {
        s.destroy();
        resolve(data.split("\r\n")[0] ?? "");
      }
    });
    s.on("error", () => resolve("error"));
  });
}

describe("the HUD loopback egress proxy", () => {
  it("only targets a loopback http hub", () => {
    expect(hubTarget("http://127.0.0.1:7420")).toEqual({ host: "127.0.0.1", port: 7420 });
    expect(hubTarget("http://localhost:7420")).toEqual({ host: "localhost", port: 7420 });
    expect(hubTarget("https://127.0.0.1:7420")).toBeNull();
    expect(hubTarget("http://example.com:7420")).toBeNull();
    expect(hubTarget("http://192.168.1.5:7420")).toBeNull();
  });

  it("forwards plain HTTP to the hub and refuses every other host or port", async () => {
    const { origin } = await hub();
    const proxy = await startHudProxy(origin);
    open.push(proxy);
    const port = new URL(origin).port;
    expect(await viaProxy(proxy.address, `${origin}/map`)).toEqual({
      status: 200,
      body: "hub:/map",
    });
    expect((await viaProxy(proxy.address, "http://example.com/")).status).toBe(403);
    expect((await viaProxy(proxy.address, "http://169.254.169.254/latest")).status).toBe(403);
    expect((await viaProxy(proxy.address, `http://127.0.0.1:${Number(port) + 1}/`)).status).toBe(
      403,
    );
    expect((await viaProxy(proxy.address, `http://127.0.0.2:${port}/`)).status).toBe(403);
    expect((await viaProxy(proxy.address, "/relative")).status).toBe(400);
  });

  it("tunnels CONNECT to the hub only", async () => {
    const { origin } = await hub();
    const proxy = await startHudProxy(origin);
    open.push(proxy);
    const port = new URL(origin).port;
    expect(await connectVia(proxy.address, `127.0.0.1:${port}`)).toContain("200");
    expect(await connectVia(proxy.address, "example.com:443")).toContain("403");
    expect(await connectVia(proxy.address, `127.0.0.1:${Number(port) + 1}`)).toContain("403");
  });

  it("refuses everything when the hub is not on loopback", async () => {
    const proxy = await startHudProxy("http://example.com:7420");
    open.push(proxy);
    expect((await viaProxy(proxy.address, "http://example.com:7420/")).status).toBe(403);
    expect(await connectVia(proxy.address, "example.com:7420")).toContain("403");
  });
});
