import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import FloatingHorizontalScrollbar from "../../src/canvas/FloatingHorizontalScrollbar.svelte";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A scroll container that jsdom reports as overflowing and extending below the fold. */
function createTarget() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => 3000 });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 1000 });
  el.getBoundingClientRect = () =>
    ({ top: 100, bottom: window.innerHeight + 500, left: 0, right: 1000, width: 1000, height: 2000 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function render(targetElement: HTMLDivElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const instance = mount(FloatingHorizontalScrollbar, { target: host, props: { targetElement, totalWidth: 3000 } });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    host.remove();
    targetElement.remove();
  });
  const bar = host.querySelector<HTMLDivElement>('[role="scrollbar"]');
  if (!bar) throw new Error("floating scrollbar did not render");
  return bar;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("FloatingHorizontalScrollbar", () => {
  it("mirrors the target's scroll position into the bar", () => {
    const target = createTarget();
    const bar = render(target);

    target.scrollLeft = 250;
    target.dispatchEvent(new Event("scroll"));

    expect(bar.scrollLeft).toBe(250);
  });

  it("does not write a stale mirrored position back while the target is smooth scrolling", async () => {
    const target = createTarget();
    const bar = render(target);

    // First frame of a smooth scroll on the target: the bar mirrors it.
    target.scrollLeft = 6;
    target.dispatchEvent(new Event("scroll"));
    expect(bar.scrollLeft).toBe(6);

    // The smooth scroll moves on before the bar's own scroll event arrives a frame later.
    await nextFrame();
    target.scrollLeft = 40;
    bar.dispatchEvent(new Event("scroll"));

    expect(target.scrollLeft).toBe(40);
  });

  it("scrolls the target when the user drags the bar", async () => {
    const target = createTarget();
    const bar = render(target);

    target.scrollLeft = 100;
    target.dispatchEvent(new Event("scroll"));
    await nextFrame();

    bar.scrollLeft = 900;
    bar.dispatchEvent(new Event("scroll"));

    expect(target.scrollLeft).toBe(900);
  });
});
