import { describe, expect, it } from 'vitest';
import { VECTOR_TOOL_GROUPS, VECTOR_TOOLS, vectorToolGroup } from '../src/vector/index.js';

describe('VECTOR_TOOL_GROUPS', () => {
	it('holds every tool exactly once', () => {
		const grouped = VECTOR_TOOL_GROUPS.flatMap((group) => group.tools);
		expect(new Set(grouped).size).toBe(grouped.length);
		expect([...grouped].sort()).toEqual([...VECTOR_TOOLS].sort());
	});

	it('has unique ids and no empty groups', () => {
		expect(new Set(VECTOR_TOOL_GROUPS.map((group) => group.id)).size).toBe(VECTOR_TOOL_GROUPS.length);
		for (const group of VECTOR_TOOL_GROUPS) expect(group.tools.length).toBeGreaterThan(0);
	});

	it('finds the group of a tool', () => {
		expect(vectorToolGroup('ellipse').id).toBe('shape');
		expect(vectorToolGroup('select').id).toBe('select');
		for (const tool of VECTOR_TOOLS) expect(vectorToolGroup(tool).tools).toContain(tool);
	});
});
