/** jsdom has no native dialog presentation. Real modal focus/paint is covered in browser tests;
 * unit tests only need the open/closed DOM state while exercising existing reader content/actions.
 */
export function mockNativeDialog() {
  const prototype = HTMLDialogElement.prototype;
  const before = Object.getOwnPropertyDescriptors(prototype);
  Object.defineProperties(prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  return () => {
    for (const name of ["showModal", "close"] as const) {
      const descriptor = before[name];
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
  };
}
