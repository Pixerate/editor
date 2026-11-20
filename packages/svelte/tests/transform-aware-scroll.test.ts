import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import {
  calculateTransformScrollAdjustment,
  findScrollContainer,
  createTransformAwareScrollPlugin,
  transformAwareScrollPluginKey,
  TransformAwareScroll,
  createTransformAwareScrollExtension,
  scrollCaretIntoView,
  scrollCaretIntoViewNow,
  cancelScheduledScroll,
} from "../src/transformAwareScroll.js";
import { initiateEditor } from "../src/editor.svelte.js";

describe("Transform-Aware Caret Scroll", () => {
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

    afterEach(() => {
      container.remove();
    });

    it("finds ancestor with overflow-y: auto", () => {
      container.style.overflowY = "auto";
      const found = findScrollContainer(child);
      expect(found).toBe(container);
    });

    it("finds ancestor with overflow: scroll", () => {
      container.style.overflow = "scroll";
      const found = findScrollContainer(child);
      expect(found).toBe(container);
    });

    it("returns null or scrollingElement when element is null", () => {
      expect(findScrollContainer(null)).toBeNull();
    });

    it("falls back to scrollingElement when no ancestor has scroll overflow", () => {
      container.style.overflow = "visible";
      const found = findScrollContainer(child);
      expect(found).toBe(document.scrollingElement ?? document.documentElement);
    });
  });

  describe("ProseMirror Plugin and TipTap Extension", () => {
    it("creates a ProseMirror plugin with the expected key and props", () => {
      const plugin = createTransformAwareScrollPlugin();
      expect(plugin.spec.key).toBe(transformAwareScrollPluginKey);
      expect(plugin.props.handleScrollToSelection).toBeDefined();
    });

    it("handleScrollToSelection intercepts scrolling and returns true", () => {
      const plugin = createTransformAwareScrollPlugin();
      const mockView: any = {
        isDestroyed: false,
        dom: document.createElement("div"),
        state: { selection: { head: 0 } },
        coordsAtPos: vi.fn(),
      };

      const handled = plugin.props.handleScrollToSelection?.(mockView);
      expect(handled).toBe(true);
      cancelScheduledScroll(mockView);
    });

    it("exports TransformAwareScroll and createTransformAwareScrollExtension", () => {
      expect(TransformAwareScroll).toBeDefined();
      expect(TransformAwareScroll.name).toBe("transformAwareScroll");

      const extension = createTransformAwareScrollExtension({ padding: 16 });
      expect(extension.options.padding).toBe(16);
    });

    it("enables transformAwareScroll by default in initiateEditor", () => {
      const editor = initiateEditor();
      const hasPlugin = editor.state.plugins.some(
        (p) => (p as any).key === transformAwareScrollPluginKey.key
      );
      expect(hasPlugin).toBe(true);
      editor.destroy();
    });

    it("allows opting out of transformAwareScroll in initiateEditor", () => {
      const editor = initiateEditor(undefined, undefined, undefined, {
        transformAwareScroll: false,
      });
      const hasPlugin = editor.state.plugins.some(
        (p) => (p as any).key === transformAwareScrollPluginKey.key
      );
      expect(hasPlugin).toBe(false);
      editor.destroy();
    });

    it("allows passing custom TransformAwareScrollOptions in initiateEditor", () => {
      const editor = initiateEditor(undefined, undefined, undefined, {
        transformAwareScroll: { padding: 24, axis: "vertical" },
      });
      const hasPlugin = editor.state.plugins.some(
        (p) => (p as any).key === transformAwareScrollPluginKey.key
      );
      expect(hasPlugin).toBe(true);
      editor.destroy();
    });
  });

  describe("scrollCaretIntoView execution", () => {
    it("adjusts scroll positions synchronously via scrollCaretIntoViewNow", () => {
      const scrollParent = document.createElement("div");
      scrollParent.style.overflowY = "auto";
      scrollParent.style.overflowX = "auto";
      document.body.appendChild(scrollParent);

      // Define mocked dimensions
      Object.defineProperty(scrollParent, "clientHeight", { value: 300, configurable: true });
      Object.defineProperty(scrollParent, "clientWidth", { value: 300, configurable: true });
      scrollParent.getBoundingClientRect = () => ({
        top: 0,
        bottom: 300,
        left: 0,
        right: 300,
        width: 300,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      scrollParent.scrollTop = 0;
      scrollParent.scrollLeft = 0;

      const editorDom = document.createElement("div");
      scrollParent.appendChild(editorDom);

      const mockView: any = {
        isDestroyed: false,
        dom: editorDom,
        state: { selection: { head: 5 } },
        coordsAtPos: vi.fn(() => ({
          top: 310,
          bottom: 330,
          left: 310,
          right: 330,
        })),
      };

      const adjusted = scrollCaretIntoViewNow(mockView, {
        container: scrollParent,
        padding: 10,
      });

      expect(adjusted).toBe(true);
      // threshold bottom = 300 - 10 = 290. coords.bottom = 330. delta = 40.
      expect(scrollParent.scrollTop).toBe(40);
      // threshold right = 300 - 10 = 290. coords.right = 330. delta = 40.
      expect(scrollParent.scrollLeft).toBe(40);

      scrollParent.remove();
    });

    it("schedules scrollCaretIntoView using requestAnimationFrame", async () => {
      const mockView: any = {
        isDestroyed: false,
        dom: document.createElement("div"),
        state: { selection: { head: 0 } },
        coordsAtPos: vi.fn(),
      };

      let rafCallback: FrameRequestCallback | null = null;
      const originalRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = vi.fn((cb) => {
        rafCallback = cb;
        return 123;
      });

      scrollCaretIntoView(mockView);
      expect(window.requestAnimationFrame).toHaveBeenCalled();

      cancelScheduledScroll(mockView);
      window.requestAnimationFrame = originalRaf;
    });
  });
});
