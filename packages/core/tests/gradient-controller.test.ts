import { describe, it, expect, vi } from 'vitest';
import { GradientController } from '../src/gradient/index.js';

describe('GradientController', () => {
	it('initializes with default gradient and selects first stop', () => {
		const ctrl = new GradientController();
		expect(ctrl.state.gradient.stops.length).toBe(2);
		expect(ctrl.state.selectedStopId).toBe(ctrl.state.gradient.stops[0].id);
		expect(ctrl.state.canUndo).toBe(false);
	});

	it('notifies subscribers on change', () => {
		const ctrl = new GradientController();
		const listener = vi.fn();
		const unsub = ctrl.subscribe(listener);
		expect(listener).toHaveBeenCalledTimes(1);

		ctrl.setAngle(270);
		expect(listener).toHaveBeenCalledTimes(2);
		expect(ctrl.state.gradient.angle).toBe(270);
		expect(ctrl.state.canUndo).toBe(true);

		unsub();
		ctrl.setAngle(45);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('supports gestures for coalesced history steps', () => {
		const ctrl = new GradientController();
		ctrl.beginGesture('Drag Angle');
		ctrl.setAngle(10);
		ctrl.setAngle(20);
		ctrl.setAngle(30);
		ctrl.endGesture();

		expect(ctrl.state.gradient.angle).toBe(30);
		expect(ctrl.state.canUndo).toBe(true);
		expect(ctrl.undo()).toBe(true);
		expect(ctrl.state.gradient.angle).toBe(180);
		expect(ctrl.state.canRedo).toBe(true);
		expect(ctrl.redo()).toBe(true);
		expect(ctrl.state.gradient.angle).toBe(30);
	});

	it('handles addStop, updateStop, removeStop, reverse, and distribute', () => {
		const ctrl = new GradientController();
		const addRes = ctrl.addStop(0.5, '#00ff00');
		expect(addRes.ok).toBe(true);
		if (!addRes.ok) return;

		expect(ctrl.state.gradient.stops).toHaveLength(3);
		expect(ctrl.state.selectedStopId).toBe(addRes.stop.id);

		ctrl.updateStop(addRes.stop.id, { color: '#ffff00' });
		expect(ctrl.getSelectedStop()?.color).toBe('#ffff00');

		ctrl.reverse();
		expect(ctrl.state.gradient.stops.length).toBe(3);

		ctrl.distribute();
		expect(ctrl.state.gradient.stops[1].offset).toBe(0.5);

		const remRes = ctrl.removeStop(addRes.stop.id);
		expect(remRes.ok).toBe(true);
		expect(ctrl.state.gradient.stops).toHaveLength(2);
	});

	it('enforces read-only protection', () => {
		const ctrl = new GradientController({ readOnly: 'Locked gradient layer' });
		expect(ctrl.isReadOnly).toBe(true);
		expect(ctrl.readOnlyReason).toBe('Locked gradient layer');

		const res = ctrl.setAngle(45);
		expect(res.ok).toBe(false);
		expect((res as any).message).toBe('Locked gradient layer');
		expect(ctrl.state.gradient.angle).toBe(180);

		const addRes = ctrl.addStop(0.5, '#ff0000');
		expect(addRes.ok).toBe(false);
	});
});
