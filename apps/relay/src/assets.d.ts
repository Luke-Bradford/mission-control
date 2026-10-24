declare module "*.sodium.mjs" {
  export default function createSodium(options: Record<string, unknown>): Promise<unknown>;
}
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
