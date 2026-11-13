import "@testing-library/jest-dom/vitest";

/** jsdom has no PointerEvent constructor; base-ui's Switch/Checkbox dispatch one on click. */
if (typeof window !== "undefined" && !window.PointerEvent) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

/** jsdom has no ImageData constructor; RawImageCanvas builds one to paint its <canvas>. */
if (typeof window !== "undefined" && !window.ImageData) {
  class ImageDataPolyfill {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace = "srgb" as PredefinedColorSpace;
    constructor(data: Uint8ClampedArray, width: number, height?: number) {
      this.data = data;
      this.width = width;
      this.height = height ?? data.length / 4 / width;
    }
  }
  window.ImageData = ImageDataPolyfill as unknown as typeof ImageData;
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

/** jsdom has no ResizeObserver; Radix's slider, tooltip and select (and cmdk's list) measure with one. */
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/** jsdom has no pointer capture or scrollIntoView; Radix's select uses both when it opens. */
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}
