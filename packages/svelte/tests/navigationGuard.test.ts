import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { navigationGuard, createNavigationGuard, DirtyTracker } from "../src";

beforeAll(() => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    {
      url: "https://example.com/editor",
    },
  );
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).MouseEvent = dom.window.MouseEvent;
  (globalThis as any).BeforeUnloadEvent =
    (dom.window as any).BeforeUnloadEvent || dom.window.Event;
});

describe("navigationGuard Svelte action", () => {
  it("attaches beforeunload to window when dirty and cleans up on destroy", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const node = document.createElement("div");
    document.body.appendChild(node);

    const action = navigationGuard(node, { isDirty: true });
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );

    action.destroy();
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
    node.remove();
  });

  it("intercepts internal link clicks when dirty", () => {
    const onBlocked = vi.fn();
    const node = document.createElement("div");
    node.innerHTML = `
      <a href="https://example.com/dashboard" id="internal-link">Dashboard</a>
      <a href="https://google.com" id="external-link">External</a>
      <a href="https://example.com/editor" id="same-page-link">Same</a>
    `;
    document.body.appendChild(node);

    const action = navigationGuard(node, {
      isDirty: true,
      onBlocked,
    });

    const internalLink = node.querySelector(
      "#internal-link",
    ) as HTMLAnchorElement;
    const samePageLink = node.querySelector(
      "#same-page-link",
    ) as HTMLAnchorElement;
    const externalLink = node.querySelector(
      "#external-link",
    ) as HTMLAnchorElement;

    // 1. Internal link click should be intercepted
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    internalLink.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onBlocked).toHaveBeenCalledWith("https://example.com/dashboard");

    // 2. Same page link click should NOT be intercepted
    onBlocked.mockClear();
    const sameClickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    samePageLink.dispatchEvent(sameClickEvent);
    expect(sameClickEvent.defaultPrevented).toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();

    // 3. External link click should NOT be intercepted
    onBlocked.mockClear();
    const externalClickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    externalLink.dispatchEvent(externalClickEvent);
    expect(externalClickEvent.defaultPrevented).toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();

    action.destroy();
    node.remove();
  });

  it("does not intercept when isDirty is false", () => {
    const onBlocked = vi.fn();
    const node = document.createElement("div");
    node.innerHTML = `<a href="https://example.com/dashboard" id="internal-link">Dashboard</a>`;
    document.body.appendChild(node);

    const action = navigationGuard(node, {
      isDirty: false,
      onBlocked,
    });

    const internalLink = node.querySelector(
      "#internal-link",
    ) as HTMLAnchorElement;
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    internalLink.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();

    action.destroy();
    node.remove();
  });
});

describe("createNavigationGuard Svelte rune helper", () => {
  it("manages guard state and navigation interception", () => {
    const onNavigate = vi.fn();
    const onBlocked = vi.fn();
    let dirty = true;

    const guard = createNavigationGuard({
      isDirty: () => dirty,
      onNavigate,
      onBlocked,
    });

    expect(guard.showConfirm).toBe(false);
    expect(guard.pendingUrl).toBe(null);

    // Intercept when dirty
    const blocked = guard.intercept("https://example.com/settings");
    expect(blocked).toBe(true);
    expect(guard.showConfirm).toBe(true);
    expect(guard.pendingUrl).toBe("https://example.com/settings");
    expect(onBlocked).toHaveBeenCalledWith("https://example.com/settings");

    // Cancel leave
    guard.cancelLeave();
    expect(guard.showConfirm).toBe(false);
    expect(guard.pendingUrl).toBe(null);

    // Intercept again and confirm leave
    guard.intercept("https://example.com/settings");
    guard.confirmLeave();
    expect(guard.showConfirm).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/settings");

    // Intercept when not dirty
    dirty = false;
    const notBlocked = guard.intercept("https://example.com/settings");
    expect(notBlocked).toBe(false);

    guard.destroy();
  });
});
