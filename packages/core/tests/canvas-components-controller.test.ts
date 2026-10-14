import { describe, it, expect } from "vitest";
import { HistoryManager } from "../src/history";
import {
  createCanvasComponentsController,
  getCanvasComponentDragId,
  getComponentSourceId,
  getInstanceData,
  getNodeOverrides,
  syncCanvasComponents,
  CANVAS_COMPONENT_DRAG_TYPE,
  type CanvasNode,
} from "../src/canvas";
import { CommandRegistry, createCommandToolProvider, createComponentCommands } from "../src/commands";
import { ToolRegistry, createCanvasComponentToolProvider } from "../src/agent";

const frame = (id: string, label: string, x: number, y: number, width: number, height: number): CanvasNode => ({
  id,
  type: "group",
  position: { x, y },
  width,
  height,
  data: { label },
});
const rect = (id: string, parentId: string, label: string, fill: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: "shape",
  parentId,
  position: { x, y },
  width: 20,
  height: 20,
  data: { label, shape: { kind: "rect", fill } },
});

function setup(withHistory = true) {
  const history = withHistory ? new HistoryManager() : undefined;
  const ctx = {
    nodes: [
      frame("card", "Card", 0, 0, 200, 100),
      rect("bg", "card", "Bg", "#eeeeee"),
      { id: "title", type: "text", parentId: "card", position: { x: 10, y: 10 }, data: { label: "Hello", name: "Title" } },
      frame("other", "Other", 0, 300, 50, 50),
    ] as CanvasNode[],
    history,
    revealed: [] as string[],
  };
  const controller = createCanvasComponentsController({
    getNodes: () => ctx.nodes,
    setNodes: (n) => {
      ctx.nodes = n;
    },
    history,
    onReveal: (n) => ctx.revealed.push(n.id),
  });
  const get = (id: string) => ctx.nodes.find((n) => n.id === id)!;
  /** A user edit outside the controller, then the sync the hooks run. */
  const edit = (id: string, fn: (n: CanvasNode) => CanvasNode) => {
    ctx.nodes = ctx.nodes.map((n) => (n.id === id ? fn(n) : n));
    controller.sync();
  };
  return { ctx, controller, history, get, edit };
}

describe("components controller", () => {
  it("makes each action one undoable step", () => {
    const { ctx, controller, history, get, edit } = setup();
    const initial = ctx.nodes;
    expect(controller.canCreateComponent(["card"])).toBe(true);
    expect(controller.canCreateComponent([])).toBe("Select the layers to make a component.");
    expect(controller.createComponent(["card"])).toMatchObject({ ok: true, ids: ["card"] });
    expect(controller.canCreateInstance("card")).toBe(true);
    expect(controller.canCreateInstance("bg")).toBe("Choose a component or component set.");
    expect(controller.canCreateInstance("card", "card")).toBe("An instance can't be placed inside its own main component.");
    const created = controller.createInstance("card", { id: "i", position: { x: 300, y: 0 } });
    expect(created).toMatchObject({ ok: true, ids: ["i"] });
    expect(ctx.nodes.filter((n) => n.parentId === "i")).toHaveLength(2);
    expect(history!.undoStack.length).toBe(2);

    // A user edit inside the instance becomes an override; a main edit reaches it.
    edit("i:bg", (n) => ({ ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#000000" } } }));
    expect(getNodeOverrides(get("i:bg"))).toEqual(["shape.fill"]);
    edit("title", (n) => ({ ...n, data: { ...n.data, label: "Main" } }));
    expect(get("i:title").data.label).toBe("Main");

    expect(controller.canResetOverrides("i")).toBe(true);
    controller.resetOverrides("i");
    expect(get("i:bg").data.shape.fill).toBe("#eeeeee");
    history!.undo();
    expect(get("i:bg").data.shape.fill).toBe("#000000");
    expect(getNodeOverrides(get("i:bg"))).toEqual(["shape.fill"]);
    history!.redo();
    expect(get("i:bg").data.shape.fill).toBe("#eeeeee");

    // Detach, then undo back to a linked instance.
    expect(controller.canDetachInstance(["i"])).toBe(true);
    controller.detachInstance(["i"]);
    expect(getInstanceData(get("i"))).toBeUndefined();
    history!.undo();
    expect(getInstanceData(get("i"))?.componentId).toBe("card");
    expect(getComponentSourceId(get("i:bg"))).toBe("bg");

    // Undo everything back to the start.
    while (history!.undoStack.length) history!.undo();
    expect(ctx.nodes.map((n) => n.id)).toEqual(initial.map((n) => n.id));
    expect(get("card").data.component).toBeUndefined();
  });

  it("goes to the main component and reports why actions can't run", () => {
    const { ctx, controller, get } = setup(false);
    controller.createComponent(["card"]);
    controller.createInstance("card", { id: "i", position: { x: 300, y: 0 } });
    ctx.nodes = ctx.nodes.map((n) => ({ ...n, selected: n.id === "i:bg" }));
    expect(controller.canGoToMainComponent()).toBe(true);
    expect(controller.goToMainComponent()).toBe("card");
    expect(get("card").selected).toBe(true);
    expect(get("i:bg").selected).toBe(false);
    expect(ctx.revealed).toEqual(["card"]);
    expect(controller.canPushOverrides("i")).toBe("The instance has no changes to push.");
    expect(controller.canRestoreMainComponent("i")).toBe("The main component still exists.");
    expect(controller.canDetachInstance(["card"])).toBe("Select an instance.");
    expect(controller.canResetOverrides("i")).toBe("No overrides to reset.");
    expect(controller.canSwapInstance("card", ["other"])).toBe("Select an instance.");
    expect(controller.inspect("i:bg")).toMatchObject({ id: "i", componentId: "card", status: "linked" });
    expect(controller.list().components.map((c) => c.id)).toEqual(["card"]);
    expect(controller.rootInstanceOf("i:bg")).toBe("i");
  });

  it("exposes commands with disabled reasons", () => {
    const { ctx, controller, get } = setup();
    const registry = new CommandRegistry();
    registry.register(createComponentCommands(controller));
    const ids = registry.list().map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "canvas.createComponent",
        "canvas.combineAsVariants",
        "canvas.createInstance",
        "canvas.detachInstance",
        "canvas.resetOverrides",
        "canvas.pushOverrides",
        "canvas.goToMainComponent",
        "canvas.swapInstance",
        "canvas.setInstanceProperties",
        "canvas.restoreMainComponent",
        "canvas.listComponents",
        "canvas.inspectInstance",
      ]),
    );
    expect(registry.execute("canvas.detachInstance", { ids: ["card"] })).toMatchObject({ ok: false, code: "disabled", message: "Select an instance." });
    expect(registry.execute("canvas.createComponent", { ids: ["card"] })).toMatchObject({ ok: true, result: { ids: ["card"] } });
    expect(registry.execute("canvas.createInstance", { componentId: "card", x: 300, y: 0 })).toMatchObject({ ok: true });
    const inst = ctx.nodes.find((n) => getInstanceData(n))!.id;
    expect(get(inst).position).toEqual({ x: 300, y: 0 });
    expect(registry.execute("canvas.setInstanceProperties", { ids: [inst], properties: { Nope: true } })).toMatchObject({
      ok: false,
      code: "failed",
      message: 'Unknown property "Nope".',
    });
    expect(registry.execute("canvas.listComponents")).toMatchObject({ ok: true, result: { components: [{ id: "card", instanceCount: 1 }] } });
    expect(registry.execute("canvas.goToMainComponent", { id: inst })).toMatchObject({ ok: true, result: { id: "card" } });
    expect(registry.list().find((e) => e.id === "canvas.createComponent")?.shortcuts.length).toBe(1);
    expect(createComponentCommands(controller, { scope: null, prefix: "c/" })[0]).toMatchObject({ id: "c/createComponent" });
  });

  it("exposes agent tools (directly and through the command tool provider)", async () => {
    const { ctx, controller, get } = setup();
    controller.createComponent(["card"]);
    const tools = new ToolRegistry();
    tools.register(createCanvasComponentToolProvider(controller));
    expect(tools.listTools().tools.map((t) => t.name)).toEqual([
      "list_components",
      "inspect_instance",
      "create_component",
      "combine_as_variants",
      "create_instance",
      "set_instance_properties",
      "swap_instance",
      "reset_overrides",
      "push_overrides",
      "detach_instance",
      "go_to_main_component",
      "restore_main_component",
    ]);
    const made = await tools.callTool("create_instance", { componentId: "card", x: 10, y: 400 });
    expect(made.isError).toBeFalsy();
    const inst = ctx.nodes.find((n) => getInstanceData(n))!.id;
    expect(get(inst).position).toEqual({ x: 10, y: 400 });
    const info = await tools.callTool("inspect_instance", { id: inst });
    expect(info.structuredContent).toMatchObject({ componentId: "card", status: "linked" });
    const refused = await tools.callTool("detach_instance", { ids: ["card"] });
    expect(refused.isError).toBe(true);

    const registry = new CommandRegistry();
    registry.register(createComponentCommands(controller));
    const viaCommands = new ToolRegistry();
    viaCommands.register(createCommandToolProvider(registry));
    const run = await viaCommands.callTool("run_command", { id: "canvas.detachInstance", params: { ids: [inst] } });
    expect(run.isError).toBeFalsy();
    expect(getInstanceData(get(inst))).toBeUndefined();
  });

  it("reads the component id of a panel drag", () => {
    const data = new Map([[CANVAS_COMPONENT_DRAG_TYPE, "card"]]);
    expect(getCanvasComponentDragId({ getData: (t: string) => data.get(t) ?? "" })).toBe("card");
    expect(getCanvasComponentDragId({ getData: () => "" })).toBeUndefined();
    expect(getCanvasComponentDragId(null)).toBeUndefined();
  });
});

describe("components: random edit sequences keep instances consistent (figcraft random_edit_sequences)", () => {
  it("survives random main and instance edits", () => {
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
    const { ctx, controller } = setup(false);
    controller.createComponent(["card"]);
    controller.createInstance("card", { id: "a", position: { x: 300, y: 0 } });
    controller.createInstance("card", { id: "b", position: { x: 600, y: 0 } });
    let k = 0;
    const colors = ["#111111", "#222222", "#333333"];
    for (let step = 0; step < 150; step++) {
      const before = ctx.nodes;
      const mains = ctx.nodes.filter((n) => n.parentId === "card").map((n) => n.id);
      const copies = ctx.nodes.filter((n) => getComponentSourceId(n) && n.parentId && n.parentId !== "card" && ["a", "b"].includes(n.parentId)).map((n) => n.id);
      const op = Math.floor(rnd() * 6);
      let after = before;
      if (op === 0) after = [...before, rect(`m${++k}`, "card", `L${k}`, pick(colors), k, k)];
      else if (op === 1 && mains.length > 1) {
        const gone = pick(mains);
        after = before.filter((n) => n.id !== gone);
      } else if (op === 2 && mains.length) {
        const id = pick(mains);
        after = before.map((n) => (n.id === id ? { ...n, data: { ...n.data, label: `x${step}` } } : n));
      } else if (op === 3 && copies.length) {
        const id = pick(copies);
        after = before.map((n) => (n.id === id && n.data.shape ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: pick(colors) } } } : n));
      } else if (op === 4 && copies.length) {
        const id = pick(copies);
        after = before.map((n) => (n.id === id ? { ...n, hidden: !n.hidden } : n));
      } else if (op === 5) {
        controller.resetOverrides(pick(["a", "b"]));
        continue;
      }
      ctx.nodes = syncCanvasComponents(before, after);
      controller.sync();
      // Invariants: parents first, and every instance mirrors its main's layers.
      const index = new Map(ctx.nodes.map((n, i) => [n.id, i]));
      for (const n of ctx.nodes) if (n.parentId) expect(index.get(n.parentId)! < index.get(n.id)!).toBe(true);
      const mainKids = ctx.nodes.filter((n) => n.parentId === "card").map((n) => n.id);
      for (const inst of ["a", "b"]) {
        const sources = ctx.nodes.filter((n) => n.parentId === inst).map((n) => getComponentSourceId(n));
        expect(sources).toEqual(mainKids);
      }
      // Overrides only name groups that differ from the main.
      for (const n of ctx.nodes) {
        const src = getComponentSourceId(n);
        if (!src || n.parentId === undefined) continue;
        const main = ctx.nodes.find((m) => m.id === src)!;
        for (const g of getNodeOverrides(n)) {
          if (g === "shape.fill") expect(n.data.shape.fill).not.toBe(main.data.shape.fill);
        }
      }
    }
    // A full rebuild agrees with the incremental result.
    expect(controller.syncAll()).toEqual(ctx.nodes);
  });
});
