import sodium from "libsodium-wrappers-sumo";

export type Sodium = typeof sodium;

const initialized = sodium.ready.then(() => sodium);

export function ready(): Promise<Sodium> {
  return initialized;
}
