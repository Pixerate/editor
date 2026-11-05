import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import FloatingHorizontalScrollbar from "../src/canvas/FloatingHorizontalScrollbar.svelte";

// jsdom has no ResizeObserver and no layout, so both are faked here.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
    this.disconnected = true;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
    flushSync();
  }
}

const observing = (el: Element) =>
  FakeResizeObserver.instances.filter((o) => o.observed.has(el));

/** A target taller than the viewport, so its own scrollbar is below the fold. */
function makeTarget(rect: { left: number; width: number }) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 4000 });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: rect.width,
  });
  setRect(el, rect);
  document.body.appendChild(el);
  return el;
}

function setRect(
  el: HTMLElement,
  { left, width }: { left: number; width: number },
) {
  el.getBoundingClientRect = () =>
    new DOMRect(left, 0, width, window.innerHeight + 500);
}

const bar = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[role="scrollbar"]');

let cleanups: (() => void)[] = [];

function render(props: { targetElement: HTMLDivElement | null }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const instance = mount(FloatingHorizontalScrollbar, { target: host, props });
  flushSync();
  let unmounted = false;
  const destroy = () => {
    if (unmounted) return;
    unmounted = true;
    unmount(instance);
    flushSync();
    host.remove();
  };
  cleanups.push(destroy);
  return { host, destroy };
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("FloatingHorizontalScrollbar", () => {
  it("re-measures when the target resizes without a window or target event", () => {
    const target = makeTarget({ left: 209, width: 600 });
    const { host } = render({ targetElement: target });
    expect(bar(host)?.style.left).toBe("209px");
    expect(bar(host)?.style.width).toBe("600px");

    setRect(target, { left: 40, width: 900 });
    const [observer] = observing(target);
    expect(observer).toBeDefined();
    observer.fire();

    expect(bar(host)?.style.left).toBe("40px");
    expect(bar(host)?.style.width).toBe("900px");
  });

  it("disconnects the observer on destroy", () => {
    const target = makeTarget({ left: 0, width: 600 });
    const { destroy } = render({ targetElement: target });
    const [observer] = observing(target);
    expect(observer).toBeDefined();

    destroy();

    expect(observer.disconnected).toBe(true);
  });

  it("follows targetElement when it arrives after mount or is replaced", () => {
    const props = $state<{ targetElement: HTMLDivElement | null }>({
      targetElement: null,
    });
    render(props);
    expect(FakeResizeObserver.instances).toHaveLength(0);

    const first = makeTarget({ left: 0, width: 600 });
    props.targetElement = first;
    flushSync();
    const [firstObserver] = observing(first);
    expect(firstObserver).toBeDefined();

    const second = makeTarget({ left: 0, width: 700 });
    props.targetElement = second;
    flushSync();

    expect(firstObserver.disconnected).toBe(true);
    expect(observing(first)).toHaveLength(0);
    expect(observing(second)).toHaveLength(1);
  });

  it("still mounts where ResizeObserver is missing", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { host } = render({
      targetElement: makeTarget({ left: 10, width: 600 }),
    });
    expect(bar(host)?.style.left).toBe("10px");
  });
});
