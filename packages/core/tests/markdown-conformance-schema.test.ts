import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateJsonSchema } from '../src/tools/schema.js';
import { createFormatCommands } from '../src/commands/format.js';
import manifestSchema from '@pixerate/markdown-conformance/schema/manifest.schema.json' with { type: 'json' };
import fixtureSchema from '@pixerate/markdown-conformance/schema/fixture.schema.json' with { type: 'json' };
import manifestData from '@pixerate/markdown-conformance/manifest.json' with { type: 'json' };

const conformanceDir = resolve(__dirname, '../../markdown-conformance');
const fixturesDir = join(conformanceDir, 'fixtures');

describe('markdown conformance schemas & validation', () => {
	it('manifest.json validates against schema/manifest.schema.json', () => {
		const errors = validateJsonSchema(manifestData, manifestSchema as any);
		expect(errors).toEqual([]);
	});

	it('fixtures validate against schema/fixture.schema.json', () => {
		const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
		expect(fixtureFiles.length).toBeGreaterThan(0);

		for (const file of fixtureFiles) {
			const content = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
			const errors = validateJsonSchema(content, fixtureSchema as any);
			expect(errors, `Validation failed for ${file}`).toEqual([]);
		}
	});

	it('case IDs are unique across all fixtures', () => {
		const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
		const seenIds = new Set<string>();

		for (const file of fixtureFiles) {
			const content = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
			for (const c of content.cases) {
				expect(seenIds.has(c.id), `Duplicate case id found: "${c.id}" in ${file}`).toBe(false);
				seenIds.add(c.id);
			}
		}

		expect(seenIds.size).toBeGreaterThanOrEqual(60);
	});

	it('each fixture case has valid selection markers in input and expected/variants', () => {
		const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

		const countMarkers = (str: string) => {
			const carets = (str.match(/‸/g) || []).length;
			const openBrackets = (str.match(/⟦/g) || []).length;
			const closeBrackets = (str.match(/⟧/g) || []).length;
			return { carets, openBrackets, closeBrackets };
		};

		for (const file of fixtureFiles) {
			const content = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
			for (const c of content.cases) {
				// Validate input
				const inCounts = countMarkers(c.input);
				const validInCaret = inCounts.carets === 1 && inCounts.openBrackets === 0 && inCounts.closeBrackets === 0;
				const validInRange = inCounts.carets === 0 && inCounts.openBrackets === 1 && inCounts.closeBrackets === 1;
				expect(
					validInCaret || validInRange,
					`Case "${c.id}" in ${file} has invalid input selection markers: carets=${inCounts.carets}, ⟦=${inCounts.openBrackets}, ⟧=${inCounts.closeBrackets}`
				).toBe(true);

				// Validate expected
				const expCounts = countMarkers(c.expected);
				const validExpCaret = expCounts.carets === 1 && expCounts.openBrackets === 0 && expCounts.closeBrackets === 0;
				const validExpRange = expCounts.carets === 0 && expCounts.openBrackets === 1 && expCounts.closeBrackets === 1;
				expect(
					validExpCaret || validExpRange,
					`Case "${c.id}" in ${file} has invalid expected selection markers: carets=${expCounts.carets}, ⟦=${expCounts.openBrackets}, ⟧=${expCounts.closeBrackets}`
				).toBe(true);

				// Validate variants if present
				if (c.variants) {
					for (const [engine, variantText] of Object.entries(c.variants)) {
						const varCounts = countMarkers(variantText as string);
						const validVarCaret = varCounts.carets === 1 && varCounts.openBrackets === 0 && varCounts.closeBrackets === 0;
						const validVarRange = varCounts.carets === 0 && varCounts.openBrackets === 1 && varCounts.closeBrackets === 1;
						expect(
							validVarCaret || validVarRange,
							`Case "${c.id}" variant "${engine}" in ${file} has invalid selection markers`
						).toBe(true);
					}
				}
			}
		}
	});

	it('every command referenced in fixtures exists in manifest or is an edit.* command', () => {
		const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
		const manifestCommandMap = new Map(manifestData.commands.map((cmd) => [cmd.id, cmd]));

		for (const file of fixtureFiles) {
			const content = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
			for (const c of content.cases) {
				const isEditCommand = c.command.startsWith('edit.');
				const manifestCmd = manifestCommandMap.get(c.command);
				expect(
					isEditCommand || Boolean(manifestCmd),
					`Unknown command "${c.command}" in case "${c.id}" of ${file}`
				).toBe(true);

				// If manifest command has params schema, test that params validate against it
				if (manifestCmd?.params) {
					const paramErrors = validateJsonSchema(c.params ?? {}, manifestCmd.params as any);
					expect(paramErrors, `Invalid params for "${c.command}" in case "${c.id}" of ${file}`).toEqual([]);
				}
			}
		}
	});

	it('every command in manifest.json is registered by createFormatCommands', () => {
		// Mock editor with can/chain
		const mockEditor: any = {
			can: () => ({
				toggleBold: () => true,
				toggleItalic: () => true,
				toggleStrike: () => true,
				toggleCode: () => true,
				setLink: () => true,
				unsetLink: () => true,
				toggleHeading: () => true,
				setParagraph: () => true,
				toggleBulletList: () => true,
				toggleOrderedList: () => true,
				toggleTaskList: () => true,
				toggleBlockquote: () => true,
				toggleCodeBlock: () => true
			}),
			chain: () => ({
				focus: () => ({
					toggleBold: () => ({ run: () => true }),
					toggleItalic: () => ({ run: () => true }),
					toggleStrike: () => ({ run: () => true }),
					toggleCode: () => ({ run: () => true }),
					setLink: () => ({ run: () => true }),
					unsetLink: () => ({ run: () => true }),
					toggleHeading: () => ({ run: () => true }),
					setParagraph: () => ({ run: () => true }),
					toggleBulletList: () => ({ run: () => true }),
					toggleOrderedList: () => ({ run: () => true }),
					toggleTaskList: () => ({ run: () => true }),
					toggleBlockquote: () => ({ run: () => true }),
					toggleCodeBlock: () => ({ run: () => true })
				})
			}),
			isActive: () => true
		};

		const commands = createFormatCommands(mockEditor);
		const registeredIds = new Set(commands.map((c) => c.id));

		for (const cmd of manifestData.commands) {
			expect(registeredIds.has(cmd.id), `Command ${cmd.id} in manifest is not registered`).toBe(true);
		}
	});
});
