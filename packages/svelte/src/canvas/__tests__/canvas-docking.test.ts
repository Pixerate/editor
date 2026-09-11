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
});
