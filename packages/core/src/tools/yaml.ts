/**
 * A small, strict YAML reader for skill frontmatter. It reads what frontmatter needs and refuses
 * the rest with a line number, so a host never silently misreads a skill:
 *
 * - `key: value` mappings, nested by indentation (spaces only);
 * - block lists (`- item`, `- key: value` items);
 * - flow lists and maps on one line (`[a, b]`, `{ a: 1, b: [x] }`);
 * - `"double"` (with escapes) and `'single'` quotes, plain scalars;
 * - `|` and `>` block text (with `-` / `+` chomping);
 * - `#` comments after a space; `true` / `false`, `null` / `~`, numbers.
 *
 * Anchors, aliases, tags, `?` keys, several documents and duplicate keys are errors. `yes`, `no`,
 * `on` and `off` stay text. Dependency-free.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
	/** 1-based line of the problem. */
	readonly line: number;
	constructor(message: string, line: number) {
		super(`line ${line}: ${message}`);
		this.name = 'YamlError';
		this.line = line;
	}
}

interface Line {
	n: number;
	indent: number;
	text: string;
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** Removes a ` #` comment outside quotes. */
function stripComment(text: string, n: number): string {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\' && quote === '"') i++;
			else if (c === quote) {
				if (quote === "'" && text[i + 1] === "'") i++;
				else quote = null;
			}
			continue;
		}
		if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(text[i - 1]))) quote = c;
		else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
	}
	if (quote) throw new YamlError(`an unclosed ${quote === '"' ? 'double' : 'single'} quote; quotes must close on the same line.`, n);
	return text;
}

function refuse(text: string, n: number) {
	const t = text.trimStart();
	if (/^&\S/.test(t)) throw new YamlError('anchors (&name) are not supported; repeat the value instead.', n);
	if (/^\*\S/.test(t)) throw new YamlError('aliases (*name) are not supported; repeat the value instead.', n);
	if (/^!/.test(t)) throw new YamlError('tags (!tag) are not supported; write the plain value.', n);
}

function scalar(raw: string, n: number): YamlValue {
	const text = raw.trim();
	if (text === '') return null;
	refuse(text, n);
	if (text.startsWith('"')) {
		if (!text.endsWith('"') || text.length < 2) throw new YamlError('a double-quoted value must end with " on the same line.', n);
		try {
			return JSON.parse(text.replace(/\\'/g, "'")) as string;
		} catch {
			throw new YamlError(`${text} is not a valid double-quoted string.`, n);
		}
	}
	if (text.startsWith("'")) {
		if (!text.endsWith("'") || text.length < 2) throw new YamlError("a single-quoted value must end with ' on the same line.", n);
		return text.slice(1, -1).replace(/''/g, "'");
	}
	if (text.startsWith('[') || text.startsWith('{')) return flow(text, n);
	if (text === 'true') return true;
	if (text === 'false') return false;
	if (text === 'null' || text === '~') return null;
	if (NUMBER.test(text)) return Number(text);
	return text;
}

/** A one-line flow list or map. */
function flow(text: string, n: number): YamlValue {
	let i = 0;
	const ws = () => {
		while (i < text.length && /\s/.test(text[i])) i++;
	};
	const value = (): YamlValue => {
		ws();
		const c = text[i];
		if (c === '[') {
			i++;
			const out: YamlValue[] = [];
			ws();
			if (text[i] === ']') {
				i++;
				return out;
			}
			for (;;) {
				out.push(value());
				ws();
				if (text[i] === ',') {
					i++;
					continue;
				}
				if (text[i] === ']') {
					i++;
					return out;
				}
				throw new YamlError(`expected , or ] in ${text}.`, n);
			}
		}
		if (c === '{') {
			i++;
			const out: Record<string, YamlValue> = {};
			ws();
			if (text[i] === '}') {
				i++;
				return out;
			}
			for (;;) {
				ws();
				const key = token(':');
				if (text[i] !== ':') throw new YamlError(`expected key: value in ${text}.`, n);
				i++;
				const k = String(scalar(key, n));
				if (Object.hasOwn(out, k)) throw new YamlError(`the key "${k}" appears twice.`, n);
				out[k] = value();
				ws();
				if (text[i] === ',') {
					i++;
					continue;
				}
				if (text[i] === '}') {
					i++;
					return out;
				}
				throw new YamlError(`expected , or } in ${text}.`, n);
			}
		}
		return scalar(token(), n);
	};
	/** A scalar up to a flow delimiter (or `stop`), keeping quoted text whole. */
	const token = (stop = ''): string => {
		ws();
		const start = i;
		if (text[i] === '"' || text[i] === "'") {
			const q = text[i++];
			while (i < text.length && text[i] !== q) i += text[i] === '\\' && q === '"' ? 2 : 1;
			i++;
			return text.slice(start, i);
		}
		while (i < text.length && !',]}'.includes(text[i]) && !(stop && text[i] === stop && /\s|$/.test(text[i + 1] ?? ''))) i++;
		return text.slice(start, i).trim();
	};
	const out = value();
	ws();
	if (i < text.length) throw new YamlError(`unexpected text after ${text.slice(0, i)}.`, n);
	return out;
}

/** Parses frontmatter-sized YAML into a value. Throws {@link YamlError} with the line. */
export function parseYaml(source: string): YamlValue {
	const lines: Line[] = [];
	source.split(/\r?\n/).forEach((raw, idx) => {
		const n = idx + 1;
		if (/^\s*\t/.test(raw)) throw new YamlError('indent with spaces, not tabs.', n);
		if (/^(---|\.\.\.)\s*$/.test(raw)) throw new YamlError('only one document is allowed.', n);
		lines.push({ n, indent: raw.length - raw.trimStart().length, text: raw.trimEnd() });
	});
	let pos = 0;
	const blank = (l: Line) => l.text.trim() === '' || l.text.trimStart().startsWith('#');
	const skip = () => {
		while (pos < lines.length && blank(lines[pos])) pos++;
	};

	/** Block text after `|` or `>`, indented more than `parent`. */
	const blockText = (style: string, parent: number): string => {
		const fold = style[0] === '>';
		const chomp = style[1] ?? '';
		const body: string[] = [];
		let indent = -1;
		while (pos < lines.length) {
			const l = lines[pos];
			if (l.text.trim() === '') {
				body.push('');
				pos++;
				continue;
			}
			if (l.indent <= parent) break;
			if (indent < 0) indent = l.indent;
			if (l.indent < indent) throw new YamlError('block text lines must keep the indent of its first line.', l.n);
			body.push(l.text.slice(indent));
			pos++;
		}
		let trailing = 0;
		while (body.length && body[body.length - 1] === '') {
			body.pop();
			trailing++;
		}
		let text = fold ? body.reduce((acc, line, i) => (i === 0 ? line : line === '' ? `${acc}\n` : acc.endsWith('\n') || acc === '' ? acc + line : `${acc} ${line}`), '') : body.join('\n');
		if (chomp === '+') text += '\n'.repeat(trailing + 1);
		else if (chomp !== '-' && body.length) text += '\n';
		return text;
	};

	const value = (indent: number): YamlValue => {
		skip();
		if (pos >= lines.length || lines[pos].indent < indent) return null;
		const first = lines[pos];
		return first.text.trimStart().startsWith('- ') || first.text.trim() === '-' ? list(first.indent) : map(first.indent);
	};

	const after = (rest: string, n: number, indent: number): YamlValue => {
		const text = stripComment(rest, n).trim();
		if (text === '') {
			skip();
			return pos < lines.length && lines[pos].indent > indent ? value(lines[pos].indent) : pos < lines.length && lines[pos].indent === indent && lines[pos].text.trimStart().startsWith('- ') ? list(indent) : null;
		}
		if (/^[|>][-+]?$/.test(text)) return blockText(text, indent);
		const v = scalar(text, n);
		// A plain value may wrap onto more-indented lines.
		if (typeof v === 'string' && !/^["'[{]/.test(text)) {
			let out = v;
			while (pos < lines.length && !blank(lines[pos]) && lines[pos].indent > indent) {
				const cont = stripComment(lines[pos].text.trim(), lines[pos].n);
				if (/:\s|:$/.test(cont)) throw new YamlError('a wrapped value cannot contain ": "; quote it or use > block text.', lines[pos].n);
				out += ` ${cont}`;
				pos++;
			}
			return out;
		}
		return v;
	};

	const map = (indent: number): Record<string, YamlValue> => {
		const out: Record<string, YamlValue> = {};
		while (pos < lines.length) {
			skip();
			if (pos >= lines.length) break;
			const l = lines[pos];
			if (l.indent < indent) break;
			if (l.indent > indent) throw new YamlError('this line is indented more than the key before it expects.', l.n);
			const text = l.text.trim();
			if (text.startsWith('- ')) throw new YamlError('a list item where a key was expected.', l.n);
			if (text.startsWith('? ')) throw new YamlError('complex keys (?) are not supported.', l.n);
			refuse(text, l.n);
			const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#][^:]*?)\s*:(\s+|$)(.*)$/.exec(text);
			if (!m) throw new YamlError(`expected "key: value", got "${text}".`, l.n);
			const key = String(scalar(m[1], l.n));
			if (Object.hasOwn(out, key)) throw new YamlError(`the key "${key}" appears twice.`, l.n);
			pos++;
			out[key] = after(m[3], l.n, indent);
		}
		return out;
	};

	const list = (indent: number): YamlValue[] => {
		const out: YamlValue[] = [];
		while (pos < lines.length) {
			skip();
			if (pos >= lines.length) break;
			const l = lines[pos];
			if (l.indent < indent) break;
			const text = l.text.trimStart();
			if (l.indent > indent || !(text.startsWith('- ') || text === '-')) {
				if (l.indent === indent) break;
				throw new YamlError('this line is indented more than the list expects.', l.n);
			}
			const rest = text === '-' ? '' : text.slice(2);
			const itemIndent = l.indent + 2;
			if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s[{"'][^:]*?)\s*:(\s+|$)/.test(rest)) {
				// "- key: value" starts a map at the item's indent.
				lines[pos] = { n: l.n, indent: itemIndent, text: `${' '.repeat(itemIndent)}${rest}` };
				out.push(map(itemIndent));
				continue;
			}
			pos++;
			out.push(after(rest, l.n, l.indent));
		}
		return out;
	};

	skip();
	if (pos >= lines.length) return null;
	const result = value(lines[pos].indent);
	skip();
	if (pos < lines.length) throw new YamlError('unexpected text; check the indentation.', lines[pos].n);
	return result;
}

/** Frontmatter of a Markdown file, parsed: the data, the body, and why it could not be read. */
export function parseFrontmatter(markdown: string): { data: Record<string, YamlValue>; body: string; error?: string; present: boolean } {
	const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(markdown);
	if (!match) return { data: {}, body: markdown, present: false };
	const body = markdown.slice(match[0].length);
	try {
		const data = parseYaml(match[1] ?? '');
		if (data === null) return { data: {}, body, present: true };
		if (typeof data !== 'object' || Array.isArray(data)) return { data: {}, body, present: true, error: 'frontmatter must be key: value lines.' };
		return { data, body, present: true };
	} catch (error) {
		const e = error as YamlError;
		// Frontmatter starts on the file's second line.
		return { data: {}, body, present: true, error: e instanceof YamlError ? `frontmatter line ${e.line + 1}: ${e.message.replace(/^line \d+: /, '')}` : String(error) };
	}
}
