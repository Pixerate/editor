// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateTransformScrollAdjustment,
  findScrollContainer,
  isScaledScrollContainer,
  createTransformAwareScrollPlugin,
  transformAwareScrollPluginKey,
  TransformAwareScroll,
  createTransformAwareScrollExtension,
  scrollCaretIntoView,
  scrollCaretIntoViewNow,
  cancelScheduledScroll,
} from "../src/extensions/transform-aware-scroll";
import { createRichTextPreset } from "../src/extensions/rich-text-preset";

/** jsdom has no layout: give an element a box, content size and on-screen rectangle. */
function layout(el: HTMLElement, box: { width: number; height: number; content?: number; scale?: number }) {
  const scale = box.scale ?? 1;
  for (const [key, value] of Object.entries({
    clientHeight: box.height,
    clientWidth: box.width,
    offsetHeight: box.height,
    offsetWidth: box.width,
    scrollHeight: box.content ?? box.height,
    scrollWidth: box.content ?? box.width,
  })) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: box.height * scale, right: box.width * scale, width: box.width * scale, height: box.height * scale, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const mockView = (dom: HTMLElement, coords = { top: 0, bottom: 0, left: 0, right: 0 }): any => ({
  isDestroyed: false,
  dom,
  state: { selection: { head: 0 } },
  coordsAtPos: vi.fn(() => coords),
});

describe("transform-aware caret scroll", () => {
  describe("calculateTransformScrollAdjustment", () => {
    const baseContainerRect = {
      top: 100,
      bottom: 500,
      left: 50,
      right: 450,
      width: 400,
      height: 400,
    };
    const clientHeight = 400;
    const clientWidth = 400;

    it("returns zero deltas when caret is comfortably within container bounds", () => {
      const result = calculateTransformScrollAdjustment({
        coords: { top: 200, bottom: 220, left: 100, right: 120 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
      });

      expect(result.deltaX).toBe(0);
      expect(result.deltaY).toBe(0);
    });

    it("calculates positive deltaY (scroll down) when caret is below bottom minus padding at 1x scale", () => {
      // containerRect.bottom = 500, padding = 12 -> threshold = 488
      // coords.bottom = 520 -> overflow by 32px
      const result = calculateTransformScrollAdjustment({
        coords: { top: 500, bottom: 520, left: 100, right: 120 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
      });

      expect(result.deltaY).toBe(32);
      expect(result.deltaX).toBe(0);
    });

    it("calculates negative deltaY (scroll up) when caret is above top plus padding at 1x scale", () => {
      // containerRect.top = 100, padding = 12 -> threshold = 112
      // coords.top = 90 -> underflow by 22px
      const result = calculateTransformScrollAdjustment({
        coords: { top: 90, bottom: 110, left: 100, right: 120 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
      });

      expect(result.deltaY).toBe(-22);
      expect(result.deltaX).toBe(0);
    });

    it("calculates positive deltaX (scroll right) when caret is past right minus padding at 1x scale", () => {
      // containerRect.right = 450, padding = 12 -> threshold = 438
      // coords.right = 470 -> overflow by 32px
      const result = calculateTransformScrollAdjustment({
        coords: { top: 200, bottom: 220, left: 450, right: 470 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
      });

      expect(result.deltaX).toBe(32);
      expect(result.deltaY).toBe(0);
    });

    it("calculates negative deltaX (scroll left) when caret is past left plus padding at 1x scale", () => {
      // containerRect.left = 50, padding = 12 -> threshold = 62
      // coords.left = 40 -> underflow by 22px
      const result = calculateTransformScrollAdjustment({
        coords: { top: 200, bottom: 220, left: 40, right: 60 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
      });

      expect(result.deltaX).toBe(-22);
      expect(result.deltaY).toBe(0);
    });

    it("scales delta correctly when container is zoomed in (e.g. 2x scale / scale = 2)", () => {
      // Screen containerRect height is 800, but clientHeight is 400 (scale = 2)
      // Screen overflow = 40px -> container delta should be 40 / 2 = 20px
      const zoomedInRect = {
        top: 100,
        bottom: 900,
        left: 50,
        right: 850,
        width: 800,
        height: 800,
      };

      const result = calculateTransformScrollAdjustment({
        coords: { top: 880, bottom: 928, left: 100, right: 120 },
        containerRect: zoomedInRect,
        clientHeight: 400,
        clientWidth: 400,
        padding: 12,
      });

      // threshold = 900 - 12 = 888. coords.bottom = 928. screen delta = 40.
      // scale = 800 / 400 = 2.
      // expected deltaY = 40 / 2 = 20.
      expect(result.deltaY).toBe(20);
    });

    it("scales delta correctly when container is zoomed out (e.g. 0.5x scale)", () => {
      // Screen containerRect height is 200, but clientHeight is 400 (scale = 0.5)
      // Screen overflow = 10px -> container delta should be 10 / 0.5 = 20px
      const zoomedOutRect = {
        top: 100,
        bottom: 300,
        left: 50,
        right: 250,
        width: 200,
        height: 200,
      };

      const result = calculateTransformScrollAdjustment({
        coords: { top: 280, bottom: 298, left: 100, right: 120 },
        containerRect: zoomedOutRect,
        clientHeight: 400,
        clientWidth: 400,
        padding: 12,
      });

      // threshold = 300 - 12 = 288. coords.bottom = 298. screen delta = 10.
      // scale = 200 / 400 = 0.5.
      // expected deltaY = 10 / 0.5 = 20.
      expect(result.deltaY).toBe(20);
    });

    it("respects axis: 'vertical' by zeroing deltaX", () => {
      const result = calculateTransformScrollAdjustment({
        coords: { top: 500, bottom: 520, left: 450, right: 470 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
        axis: "vertical",
      });

      expect(result.deltaY).toBe(32);
      expect(result.deltaX).toBe(0);
    });

    it("respects axis: 'horizontal' by zeroing deltaY", () => {
      const result = calculateTransformScrollAdjustment({
        coords: { top: 500, bottom: 520, left: 450, right: 470 },
        containerRect: baseContainerRect,
        clientHeight,
        clientWidth,
        padding: 12,
        axis: "horizontal",
      });

      expect(result.deltaY).toBe(0);
      expect(result.deltaX).toBe(32);
    });

    it("falls back gracefully when client dimensions are 0 or unmapped", () => {
      const result = calculateTransformScrollAdjustment({
        coords: { top: 500, bottom: 520, left: 100, right: 120 },
        containerRect: { ...baseContainerRect, height: 0, width: 0 },
        clientHeight: 0,
        clientWidth: 0,
        padding: 12,
      });

      // Fallback scale is 1
      expect(Number.isFinite(result.deltaY)).toBe(true);
      expect(result.deltaY).toBe(32);
    });
  });

  describe("findScrollContainer", () => {
    let container: HTMLDivElement;
    let child: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement("div");
      child = document.createElement("div");
      container.appendChild(child);
      document.body.appendChild(container);
    });

    afterEach(() => container.remove());

    it("finds an ancestor with overflow-y: auto whose content overflows", () => {
      container.style.overflowY = "auto";
      layout(container, { width: 100, height: 100, content: 400 });
      expect(findScrollContainer(child)).toBe(container);
    });

    it("finds an ancestor with overflow: scroll whose content overflows", () => {
      container.style.overflow = "scroll";
      layout(container, { width: 100, height: 100, content: 400 });
      expect(findScrollContainer(child)).toBe(container);
    });

    it("skips an overflow: auto ancestor whose content fits, to the one that scrolls", () => {
      const outer = document.createElement("div");
      outer.style.overflowY = "auto";
      layout(outer, { width: 100, height: 100, content: 400 });
      document.body.appendChild(outer);
      outer.appendChild(container);
      container.style.overflowY = "auto";
      layout(container, { width: 100, height: 400 });
      expect(findScrollContainer(child)).toBe(outer);
      outer.remove();
    });

    it("is null when nothing scrolls (the page does) or there's no element", () => {
      container.style.overflow = "visible";
      expect(findScrollContainer(child)).toBeNull();
      expect(findScrollContainer(null)).toBeNull();
    });
  });

  describe("isScaledScrollContainer", () => {
    it("is true only when the container is drawn at a scale other than 1", () => {
      const el = document.createElement("div");
      layout(el, { width: 300, height: 300 });
      expect(isScaledScrollContainer(el)).toBe(false);
      layout(el, { width: 300, height: 300, scale: 0.5 });
      expect(isScaledScrollContainer(el)).toBe(true);
      layout(el, { width: 300, height: 300, scale: 1.005 });
      expect(isScaledScrollContainer(el)).toBe(false);
    });
  });

  describe("plugin and extension", () => {
    let scroller: HTMLDivElement;
    let dom: HTMLDivElement;

    beforeEach(() => {
      scroller = document.createElement("div");
      scroller.style.overflowY = "auto";
      dom = document.createElement("div");
      scroller.appendChild(dom);
      document.body.appendChild(scroller);
    });

    afterEach(() => scroller.remove());

    it("has the plugin key and a handleScrollToSelection prop", () => {
      const plugin = createTransformAwareScrollPlugin();
      expect(plugin.spec.key).toBe(transformAwareScrollPluginKey);
      expect(plugin.props.handleScrollToSelection).toBeDefined();
    });

    it("leaves scrolling to ProseMirror when the container isn't scaled", () => {
      layout(scroller, { width: 300, height: 300, content: 900 });
      const view = mockView(dom);
      expect(createTransformAwareScrollPlugin().props.handleScrollToSelection?.call(null as any, view)).toBe(false);
    });

    it("leaves scrolling to ProseMirror when no ancestor scrolls (the page scrolls)", () => {
      scroller.style.overflowY = "visible";
      const view = mockView(dom);
      expect(createTransformAwareScrollPlugin().props.handleScrollToSelection?.call(null as any, view)).toBe(false);
    });

    it("takes over when the container is scaled", () => {
      layout(scroller, { width: 300, height: 300, content: 900, scale: 2 });
      const view = mockView(dom);
      expect(createTransformAwareScrollPlugin().props.handleScrollToSelection?.call(null as any, view)).toBe(true);
      cancelScheduledScroll(view);
    });

    it("exports TransformAwareScroll and createTransformAwareScrollExtension", () => {
      expect(TransformAwareScroll.name).toBe("transformAwareScroll");
      expect(createTransformAwareScrollExtension({ padding: 16 }).options.padding).toBe(16);
    });

    it("is in createRichTextPreset by default, takes options, and can be turned off", () => {
      const named = (options: Parameters<typeof createRichTextPreset>[0]) =>
        createRichTextPreset(options).find((e) => e.name === "transformAwareScroll");
      expect(named({})).toBeDefined();
      expect(named({ transformAwareScroll: { padding: 24 } })?.options.padding).toBe(24);
      expect(named({ transformAwareScroll: false })).toBeUndefined();
    });
  });

  describe("scrolling", () => {
    let scroller: HTMLDivElement;
    let dom: HTMLDivElement;

    beforeEach(() => {
      scroller = document.createElement("div");
      dom = document.createElement("div");
      scroller.appendChild(dom);
      document.body.appendChild(scroller);
    });

    afterEach(() => scroller.remove());

    it("scrolls by the on-screen overflow at scale 1", () => {
      layout(scroller, { width: 300, height: 300, content: 900 });
      const view = mockView(dom, { top: 310, bottom: 330, left: 310, right: 330 });
      expect(scrollCaretIntoViewNow(view, { container: scroller, padding: 10 })).toBe(true);
      expect(scroller.scrollTop).toBe(40);
      expect(scroller.scrollLeft).toBe(40);
    });

    it("divides the overflow by the container's scale", () => {
      // Drawn at 2x: the 300px box is 600px on screen
      layout(scroller, { width: 300, height: 300, content: 900, scale: 2 });
      const view = mockView(dom, { top: 610, bottom: 630, left: 0, right: 20 });
      expect(scrollCaretIntoViewNow(view, { container: scroller, padding: 10, axis: "vertical" })).toBe(true);
      expect(scroller.scrollTop).toBe(20); // (630 - 590) / 2
      expect(scroller.scrollLeft).toBe(0);
    });

    it("does nothing for a destroyed view", () => {
      const view = { ...mockView(dom), isDestroyed: true };
      expect(scrollCaretIntoViewNow(view, { container: scroller })).toBe(false);
    });

    it("schedules one scroll per frame and cancels it", () => {
      layout(scroller, { width: 300, height: 300, content: 900 });
      const view = mockView(dom, { top: 310, bottom: 330, left: 0, right: 0 });
      const callbacks: FrameRequestCallback[] = [];
      const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => callbacks.push(cb));
      const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      scrollCaretIntoView(view, { container: scroller, padding: 10 });
      scrollCaretIntoView(view, { container: scroller, padding: 10 });
      expect(cancel).toHaveBeenCalledTimes(1);
      callbacks.at(-1)!(0);
      expect(scroller.scrollTop).toBe(40);
      raf.mockRestore();
      cancel.mockRestore();
    });
  });
});
