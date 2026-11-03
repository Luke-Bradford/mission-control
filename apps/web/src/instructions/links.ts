export const ORDER_ANCHOR_PREFIX = "order-";
export const orderAnchor = (id: number): string => `${ORDER_ANCHOR_PREFIX}${id}`;
export const orderHref = (id: number): string => `/flight#${orderAnchor(id)}`;
export const orderFromHash = (hash: string): number | null => {
  const match = /^#order-([1-9]\d*)$/.exec(hash);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) ? value : null;
};
