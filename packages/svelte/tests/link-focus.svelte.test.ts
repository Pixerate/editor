import { describe, it, expect } from 'vitest';
import { linkFocusOf } from '../src';
import { createLinkFocus } from '@pixerate/editor/tools';

const links = { a: ['x'], b: ['x', 'y'] };
const marks = [['a'], ['b'], ['x'], ['y'], ['a', 'x'], ['b', 'x'], ['b', 'y']];

describe('linkFocusOf', () => {
	it('follows the model: hover, keys, Escape, opacities and the description', () => {
		const binding = linkFocusOf({ marks, links, dim: 0.2 });
		binding.mark('x').onpointerenter();
		expect(binding.state.focus).toBe('x');
		expect(marks.map((_, i) => binding.opacity(i))).toEqual([1, 1, 1, 0.2, 1, 1, 0.2]);
		expect(binding.description).toBe('x, 3 of 4: linked to 2 others, a, b.');
		const keydown = (key: string) => {
			const event = new KeyboardEvent('keydown', { key, cancelable: true });
			binding.root.onkeydown(event);
			return event.defaultPrevented;
		};
		expect(keydown('ArrowRight')).toBe(true);
		expect(binding.state.focus).toBe('y');
		expect(keydown('Escape')).toBe(true);
		expect(binding.state.focus).toBeNull();
		expect(keydown('a')).toBe(false);
		binding.mark('a').onfocus();
		binding.root.onpointerleave();
		expect(binding.state.focus).toBeNull();
		binding.destroy();
	});

	it('adopts a model and clears when focus leaves the container', () => {
		const model = createLinkFocus({ marks, links });
		const binding = linkFocusOf(model);
		const container = document.createElement('div');
		const inside = document.createElement('button');
		container.appendChild(inside);
		model.focus('b');
		binding.root.onfocusout({ currentTarget: container, relatedTarget: inside } as unknown as FocusEvent);
		expect(binding.state.focus).toBe('b');
		binding.root.onfocusout({ currentTarget: container, relatedTarget: null } as unknown as FocusEvent);
		expect(binding.state.focus).toBeNull();
		binding.destroy();
		model.focus('a');
		expect(binding.state.focus).toBeNull();
	});
});
