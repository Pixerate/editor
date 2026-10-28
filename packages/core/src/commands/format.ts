import type { Editor } from '@tiptap/core';
import type { CommandParamsSchema, CommandSpec } from './registry.js';
import type { ShortcutInput } from './shortcuts.js';
import manifestData from '@pixerate/markdown-conformance/manifest.json' with { type: 'json' };

export interface FormatManifestCommand {
	id: string;
	label: string;
	group?: string;
	shortcut?: ShortcutInput;
	shortcuts?: Record<string, string>;
	surfaces?: readonly string[];
	params?: CommandParamsSchema;
	enabledWhen?: readonly string[];
}

export interface CodeLanguageOption {
	id: string;
	label: string;
	shortLabel?: string;
}

export interface FormatManifest {
	$schema?: string;
	commands: readonly FormatManifestCommand[];
	codeLanguages?: readonly CodeLanguageOption[];
}

export interface FormatCommandOptions {
	/** Custom manifest or subset; defaults to the full manifest from `@pixerate/markdown-conformance`. */
	manifest?: FormatManifest;
	/** Id prefix (default `format.`). Commands in manifest matching this prefix will be stripped/remapped appropriately. */
	prefix?: string;
	/** Scope the commands belong to, e.g. `editor`. */
	scope?: string;
	/** Focus the editor when a command runs (default `true`). */
	focus?: boolean;
}

/**
 * Returns commands from a format manifest filtered for a specific UI surface
 * (e.g. `'bubble'`, `'menu'`, `'palette'`, or `'keyboardBar'`).
 */
export function formatCommandsFor(
	surface: 'bubble' | 'menu' | 'palette' | 'keyboardBar' | string,
	manifest: FormatManifest = manifestData as FormatManifest
): FormatManifestCommand[] {
	return manifest.commands.filter((cmd) => cmd.surfaces?.includes(surface));
}

/**
 * Creates format commands (`format.*`) registered from the format manifest in `@pixerate/markdown-conformance`.
 * Commands can be placed in bubble menus, menus, keyboard bars, or palettes, or called programmatically by agent tools.
 */
export function createFormatCommands(editor: Editor, options: FormatCommandOptions = {}): CommandSpec[] {
	const manifest = options.manifest ?? (manifestData as FormatManifest);
	const prefix = options.prefix ?? 'format.';
	const scope = options.scope ? { scope: options.scope } : {};
	const shouldFocus = options.focus ?? true;

	const withFocus = () => {
		return shouldFocus ? editor.chain().focus() : editor.chain();
	};

	return manifest.commands.map((cmdDef): CommandSpec => {
		// e.g. cmdDef.id is "format.bold", strip "format." if needed or use as is
		const canonicalId = cmdDef.id.startsWith('format.') ? cmdDef.id.slice('format.'.length) : cmdDef.id;
		const id = `${prefix}${canonicalId}`;

		let run: (context: unknown, params: any) => unknown;
		let enabled: ((context: unknown, params: any) => boolean | string | undefined) | undefined;

		switch (canonicalId) {
			case 'bold':
				enabled = () => (editor.can().toggleBold() ? true : 'Cannot toggle bold at current selection.');
				run = () => withFocus().toggleBold().run();
				break;

			case 'italic':
				enabled = () => (editor.can().toggleItalic() ? true : 'Cannot toggle italic at current selection.');
				run = () => withFocus().toggleItalic().run();
				break;

			case 'strikethrough':
				enabled = () => (editor.can().toggleStrike() ? true : 'Cannot toggle strikethrough at current selection.');
				run = () => withFocus().toggleStrike().run();
				break;

			case 'code':
				enabled = () => (editor.can().toggleCode() ? true : 'Cannot toggle inline code at current selection.');
				run = () => withFocus().toggleCode().run();
				break;

			case 'link':
				enabled = (_ctx, p: { url?: string | null } | undefined) => {
					if (p?.url) {
						return editor.can().setLink({ href: p.url }) ? true : 'Cannot set link at current selection.';
					}
					return editor.can().unsetLink() || editor.can().setLink({ href: 'https://example.com' })
						? true
						: 'Cannot modify link at current selection.';
				};
				run = (_ctx, p: { url?: string | null } | undefined) => {
					if (p?.url) {
						return withFocus().setLink({ href: p.url }).run();
					}
					return withFocus().unsetLink().run();
				};
				break;

			case 'heading':
				enabled = (_ctx, p: { level: number } | undefined) => {
					const level = p?.level as 1 | 2 | 3 | 4 | 5 | 6 | undefined;
					if (level) {
						return editor.can().toggleHeading({ level }) ? true : `Cannot toggle heading level ${level}.`;
					}
					return true;
				};
				run = (_ctx, p: { level: number }) => {
					return withFocus().toggleHeading({ level: p.level as 1 | 2 | 3 | 4 | 5 | 6 }).run();
				};
				break;

			case 'paragraph':
				enabled = () => (editor.can().setParagraph() ? true : 'Cannot set paragraph at current selection.');
				run = () => withFocus().setParagraph().run();
				break;

			case 'bulletList':
				enabled = () => (editor.can().toggleBulletList() ? true : 'Cannot toggle bullet list at current selection.');
				run = () => withFocus().toggleBulletList().run();
				break;

			case 'numberedList':
				enabled = () => (editor.can().toggleOrderedList() ? true : 'Cannot toggle numbered list at current selection.');
				run = () => withFocus().toggleOrderedList().run();
				break;

			case 'taskList':
				enabled = () => (editor.can().toggleTaskList() ? true : 'Cannot toggle task list at current selection.');
				run = () => withFocus().toggleTaskList().run();
				break;

			case 'quote':
				enabled = () => (editor.can().toggleBlockquote() ? true : 'Cannot toggle blockquote at current selection.');
				run = () => withFocus().toggleBlockquote().run();
				break;

			case 'codeBlock':
				enabled = (_ctx, p: { language?: string | null } | undefined) => {
					const lang = p?.language;
					if (editor.isActive('codeBlock')) {
						return true;
					}
					return editor.can().toggleCodeBlock(lang ? { language: lang } : undefined)
						? true
						: 'Cannot toggle code block at current selection.';
				};
				run = (_ctx, p: { language?: string | null } | undefined) => {
					const lang = p?.language;
					if (editor.isActive('codeBlock')) {
						if (p !== undefined && 'language' in p) {
							return withFocus().updateAttributes('codeBlock', { language: lang ?? null }).run();
						}
						return withFocus().toggleCodeBlock().run();
					}
					return withFocus().toggleCodeBlock(lang ? { language: lang } : undefined).run();
				};
				break;

			case 'table':
				enabled = () => (editor.isActive('table') ? true : 'Not inside a table.');
				run = () => {
					// table toggle / insert or focus
					return true;
				};
				break;

			default:
				enabled = () => true;
				run = () => true;
				break;
		}

		return {
			id,
			label: cmdDef.label,
			group: cmdDef.group,
			shortcut: cmdDef.shortcut,
			...(cmdDef.params ? { params: cmdDef.params } : {}),
			...scope,
			enabled,
			run
		};
	});
}
