import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Workers require a statically imported WASM module rather than runtime compilation of bytes.
const require = createRequire(
  new URL("../../../packages/agentcomms/src/sodium.ts", import.meta.url),
);
const wrapperRequire = createRequire(require.resolve("libsodium-wrappers-sumo"));
const root = dirname(dirname(dirname(wrapperRequire.resolve("libsodium-sumo"))));
const source = await readFile(join(root, "dist/modules-sumo-esm/libsodium-sumo.mjs"), "utf8");
const encoded = source.match(/"(AGFzbQ[A-Za-z0-9+/=]+)"/);
if (!encoded) throw new Error("Installed libsodium has no embedded WASM module");
const dir = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "sodium.wasm"), Buffer.from(encoded[1], "base64"));
await writeFile(join(dir, "libsodium.sodium.mjs"), source.replace(encoded[0], '""'));
