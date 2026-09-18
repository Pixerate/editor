import { describe, it, expect, vi } from 'vitest';
import { createCanvasDocking } from '../createCanvasDocking.svelte.js';
import type { CanvasNode } from '../types.js';

describe('createCanvasDocking', () => {
  const createSampleNode = (id: string, type = 'default', x = 0, y = 0): CanvasNode => ({
    id,
    type,
    position: { x, y },
    data: {}
  });

  it('initializes with null drag and connect states', () => {
    const docking = createCanvasDocking();

    expect(docking.isDragging).toBe(false);
    expect(docking.draggedNode).toBeNull();
    expect(docking.draggedInitialPosition).toBeNull();
    expect(docking.connectingHandle).toBe('');
    expect(docking.connectingNode).toBeNull();
  });

  it('tracks drag start, records initial position, and sets isDragging', () => {
    const docking = createCanvasDocking();
    const node = createSampleNode('n1', 'default', 100, 200);

    docking.handleNodeDragStart({ targetNode: node });

    expect(docking.isDragging).toBe(true);
    expect(docking.draggedNode).toBe(node);
    expect(docking.draggedInitialPosition).toEqual({ x: 100, y: 200 });
  });

  it('fires onDockHover and onDockLeave as intersecting dock targets change', () => {
    const onDockHover = vi.fn();
    const onDockLeave = vi.fn();
    const docking = createCanvasDocking({
      isDockTarget: (n) => n.type === 'dockArea',
      onDockHover,
      onDockLeave
    });

    const draggedNode = createSampleNode('dragged', 'item', 50, 50);
    const dockNode1 = createSampleNode('dock-1', 'dockArea', 0, 0);
    const dockNode2 = createSampleNode('dock-2', 'dockArea', 200, 200);
    const normalNode = createSampleNode('normal', 'item', 50, 50);

    docking.handleNodeDragStart({ targetNode: draggedNode });

    // Drag intersecting with dockNode1 and a non-dock normalNode
    docking.handleNodeDrag(
      { targetNode: draggedNode },
      () => [dockNode1, normalNode]
    );

    expect(onDockHover).toHaveBeenCalledTimes(1);
    expect(onDockHover).toHaveBeenCalledWith(dockNode1, draggedNode);
    expect(onDockLeave).not.toHaveBeenCalled();

    // Drag moves over dockNode2, leaving dockNode1
    docking.handleNodeDrag(
      { targetNode: draggedNode },
      () => [dockNode2]
    );

    expect(onDockLeave).toHaveBeenCalledTimes(1);
    expect(onDockLeave).toHaveBeenCalledWith(expect.objectContaining({ id: 'dock-1' }), draggedNode);
    expect(onDockHover).toHaveBeenCalledTimes(2);
    expect(onDockHover).toHaveBeenLastCalledWith(dockNode2, draggedNode);
  });

  it('fires onDockDrop and restores position on dock stop', () => {
    const onDockDrop = vi.fn();
    const onSave = vi.fn();
    const updateNodePosition = vi.fn();

    const docking = createCanvasDocking({
      isDockTarget: (n) => n.type === 'dockArea',
      restorePositionOnDock: true,
      onDockDrop,
      onSave
    });

    const draggedNode = createSampleNode('dragged', 'item', 100, 100);
    const dockNode = createSampleNode('dock', 'dockArea', 0, 0);

    docking.handleNodeDragStart({ targetNode: draggedNode });

    // Node was dragged to new position
    draggedNode.position = { x: 300, y: 300 };

    docking.handleNodeDragStop(
      { targetNode: draggedNode },
      () => [dockNode],
      updateNodePosition
    );

    expect(onDockDrop).toHaveBeenCalledWith(dockNode, draggedNode);
    expect(updateNodePosition).toHaveBeenCalledWith('dragged', { x: 100, y: 100 });
    expect(onSave).toHaveBeenCalled();
    expect(docking.isDragging).toBe(false);
    expect(docking.draggedNode).toBeNull();
  });

  it('tracks handle connect start and end', () => {
    const docking = createCanvasDocking();
    const node = createSampleNode('source-node');
    const getNode = (id: string) => (id === 'source-node' ? node : undefined);

    docking.handleConnectStart(
      { nodeId: 'source-node', handleId: 'h1', handleType: 'source' },
      getNode
    );

    expect(docking.connectingHandle).toBe('source');
    expect(docking.connectingNode).toBe(node);

    docking.handleConnectEnd();

    expect(docking.connectingHandle).toBe('');
    expect(docking.connectingNode).toBeNull();
  });

  it('resets all state cleanly', () => {
    const docking = createCanvasDocking();
    const node = createSampleNode('test');

    docking.handleNodeDragStart({ targetNode: node });
    expect(docking.isDragging).toBe(true);

    docking.reset();
    expect(docking.isDragging).toBe(false);
    expect(docking.draggedNode).toBeNull();
    expect(docking.draggedInitialPosition).toBeNull();
  });

  describe('Dock Target Disambiguation & Exclusive Hover', () => {
    it('disambiguates adjacent targets using default center-point strategy and exclusive hover', () => {
      const onDockHover = vi.fn();
      const onDockLeave = vi.fn();
      const onDockDrop = vi.fn();

      const docking = createCanvasDocking({
        isDockTarget: (n) => n.type === 'dockArea',
        onDockHover,
        onDockLeave,
        onDockDrop
      });

      // Adjacent columns: dockA [0, 200] and dockB [200, 400]
      const dockA = {
        ...createSampleNode('dock-a', 'dockArea', 0, 0),
        measured: { width: 200, height: 400 }
      };
      const dockB = {
        ...createSampleNode('dock-b', 'dockArea', 200, 0),
        measured: { width: 200, height: 400 }
      };

      // Dragged card with width 100, positioned at x: 50 -> center is x: 100 (inside dockA)
      const draggedNode = {
        ...createSampleNode('dragged', 'item', 50, 50),
        measured: { width: 100, height: 50 }
      };

      docking.handleNodeDragStart({ targetNode: draggedNode });

      // Even if xyflow returns both intersecting targets
      docking.handleNodeDrag(
        { targetNode: draggedNode },
        () => [dockA, dockB]
      );

      // Only dockA receives hover
      expect(onDockHover).toHaveBeenCalledTimes(1);
      expect(onDockHover).toHaveBeenCalledWith(dockA, draggedNode);
      expect(onDockLeave).not.toHaveBeenCalled();

      // Card dragged across boundary: x: 160 -> center is x: 210 (inside dockB)
      draggedNode.position = { x: 160, y: 50 };
      docking.handleNodeDrag(
        { targetNode: draggedNode },
        () => [dockA, dockB]
      );

      // dockA is left, dockB is entered
      expect(onDockLeave).toHaveBeenCalledTimes(1);
      expect(onDockLeave).toHaveBeenCalledWith(expect.objectContaining({ id: 'dock-a' }), draggedNode);
      expect(onDockHover).toHaveBeenCalledTimes(2);
      expect(onDockHover).toHaveBeenLastCalledWith(dockB, draggedNode);

      // Dropping selects dockB, not dockA
      docking.handleNodeDragStop(
        { targetNode: draggedNode },
        () => [dockA, dockB]
      );

      expect(onDockDrop).toHaveBeenCalledTimes(1);
      expect(onDockDrop).toHaveBeenCalledWith(dockB, draggedNode);
    });

    it('disambiguates candidate targets using max-overlap strategy', () => {
      const onDockHover = vi.fn();
      const onDockDrop = vi.fn();

      const docking = createCanvasDocking({
        isDockTarget: (n) => n.type === 'dockArea',
        dockStrategy: 'max-overlap',
        onDockHover,
        onDockDrop
      });

      // dockA: [0, 100] (area overlap will be 20 * 50 = 1000)
      const dockA = {
        ...createSampleNode('dock-a', 'dockArea', 0, 0),
        measured: { width: 100, height: 200 }
      };
      // dockB: [100, 300] (area overlap will be 80 * 50 = 4000)
      const dockB = {
        ...createSampleNode('dock-b', 'dockArea', 100, 0),
        measured: { width: 200, height: 200 }
      };

      // Dragged card spanning x: 80 to 180 (width 100)
      const draggedNode = {
        ...createSampleNode('dragged', 'item', 80, 50),
        measured: { width: 100, height: 50 }
      };

      docking.handleNodeDragStart({ targetNode: draggedNode });
      docking.handleNodeDrag({ targetNode: draggedNode }, () => [dockA, dockB]);

      // dockB has the larger overlap area (80px vs 20px width)
      expect(onDockHover).toHaveBeenCalledWith(dockB, draggedNode);

      docking.handleNodeDragStop({ targetNode: draggedNode }, () => [dockA, dockB]);
      expect(onDockDrop).toHaveBeenCalledWith(dockB, draggedNode);
    });

    it('allows custom resolvePrimaryDockTarget callback to take precedence', () => {
      const onDockHover = vi.fn();
      const onDockDrop = vi.fn();

      const dockA = createSampleNode('dock-a', 'dockArea', 0, 0);
      const dockB = createSampleNode('dock-b', 'dockArea', 100, 0);
      const draggedNode = createSampleNode('dragged', 'item', 0, 0);

      const docking = createCanvasDocking({
        isDockTarget: (n) => n.type === 'dockArea',
        resolvePrimaryDockTarget: (targets) => targets.find((t) => t.id === 'dock-b') ?? null,
        onDockHover,
        onDockDrop
      });

      docking.handleNodeDragStart({ targetNode: draggedNode });
      docking.handleNodeDrag({ targetNode: draggedNode }, () => [dockA, dockB]);

      expect(onDockHover).toHaveBeenCalledWith(dockB, draggedNode);

      docking.handleNodeDragStop({ targetNode: draggedNode }, () => [dockA, dockB]);
      expect(onDockDrop).toHaveBeenCalledWith(dockB, draggedNode);
    });

    it('supports non-exclusive hover mode when exclusiveHover is false', () => {
      const onDockHover = vi.fn();
      const onDockLeave = vi.fn();

      const docking = createCanvasDocking({
        isDockTarget: (n) => n.type === 'dockArea',
        exclusiveHover: false,
        onDockHover,
        onDockLeave
      });

      const dockA = createSampleNode('dock-a', 'dockArea', 0, 0);
      const dockB = createSampleNode('dock-b', 'dockArea', 100, 0);
      const draggedNode = createSampleNode('dragged', 'item', 50, 0);

      docking.handleNodeDragStart({ targetNode: draggedNode });
      docking.handleNodeDrag({ targetNode: draggedNode }, () => [dockA, dockB]);

      // Both targets should receive hover in non-exclusive mode
      expect(onDockHover).toHaveBeenCalledTimes(2);
      expect(onDockHover).toHaveBeenCalledWith(dockA, draggedNode);
      expect(onDockHover).toHaveBeenCalledWith(dockB, draggedNode);
    });
  });
});
