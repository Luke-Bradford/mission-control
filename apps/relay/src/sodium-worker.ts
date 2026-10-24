import createSodium from "../dist/libsodium.sodium.mjs";
import wasm from "../dist/sodium.wasm";

export default function sodium(options: Record<string, unknown>) {
  return createSodium({
    ...options,
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance) => void,
    ) {
      const instance = new WebAssembly.Instance(wasm, imports);
      receive(instance);
      return instance.exports;
    },
  });
}
