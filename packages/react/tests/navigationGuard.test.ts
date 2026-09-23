import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useNavigationGuard,
  useDismissGuard,
  DirtyTracker,
  createDirtyTracker,
} from "../src";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).BeforeUnloadEvent =
    (dom.window as any).BeforeUnloadEvent || dom.window.Event;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("useNavigationGuard", () => {
  it("attaches beforeunload listener when dirty", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    function TestComponent({ isDirty }: { isDirty: boolean }) {
      useNavigationGuard({ isDirty });
      return React.createElement("div", null, "Editor");
    }

    await act(async () => {
      root.render(React.createElement(TestComponent, { isDirty: true }));
    });

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );

    await act(async () => {
      root.unmount();
    });

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
  });

  it("intercepts internal link clicks when dirty and allows confirming leave", async () => {
    let guardRef: any;
    const onBlocked = vi.fn();
    const onNavigate = vi.fn();

    function TestComponent({ isDirty }: { isDirty: boolean }) {
      const guard = useNavigationGuard({
        isDirty,
        onBlocked,
        onNavigate,
      });
      guardRef = guard;
      return React.createElement(
        "div",
        null,
        React.createElement(
          "a",
          { href: "https://example.com/other-page", id: "internal-link" },
          "Leave",
        ),
      );
    }

    await act(async () => {
      root.render(React.createElement(TestComponent, { isDirty: true }));
    });

    expect(guardRef.showConfirm).toBe(false);

    // Simulate clicking internal link
    const link = container.querySelector("#internal-link") as HTMLAnchorElement;
    await act(async () => {
      const clickEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      link.dispatchEvent(clickEvent);
    });

    expect(guardRef.showConfirm).toBe(true);
    expect(guardRef.pendingUrl).toBe("https://example.com/other-page");
    expect(onBlocked).toHaveBeenCalledWith("https://example.com/other-page");

    // Test confirming leave
    await act(async () => {
      guardRef.confirmLeave();
    });

    expect(guardRef.showConfirm).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/other-page");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("useDismissGuard", () => {
  it("triggers confirmation on Escape key when dirty", async () => {
    let guardRef: any;
    const onDismiss = vi.fn();

    function TestComponent({ isDirty }: { isDirty: boolean }) {
      const guard = useDismissGuard({ isDirty, onDismiss });
      guardRef = guard;
      return React.createElement(
        "div",
        {
          onKeyDown: guard.handleKeyDown,
          tabIndex: 0,
          id: "guard-target",
        },
        "Modal Content",
      );
    }

    await act(async () => {
      root.render(React.createElement(TestComponent, { isDirty: true }));
    });

    const target = container.querySelector("#guard-target") as HTMLElement;

    // Press Escape
    await act(async () => {
      const escEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(escEvent);
    });

    expect(guardRef.showConfirm).toBe(true);
    expect(onDismiss).not.toHaveBeenCalled();

    // Confirm discard
    await act(async () => {
      guardRef.confirmDismiss();
    });

    expect(guardRef.showConfirm).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("calls onDismiss directly when not dirty", async () => {
    let guardRef: any;
    const onDismiss = vi.fn();

    function TestComponent({ isDirty }: { isDirty: boolean }) {
      const guard = useDismissGuard({ isDirty, onDismiss });
      guardRef = guard;
      return React.createElement("div", null, "Clean Content");
    }

    await act(async () => {
      root.render(React.createElement(TestComponent, { isDirty: false }));
    });

    await act(async () => {
      guardRef.requestDismiss();
    });

    expect(guardRef.showConfirm).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });
});
