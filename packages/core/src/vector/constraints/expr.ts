// Portions ported from cadcraft/crates/constraints/src/expr.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * A tiny expression language for dimensional constraints and named parameters: numbers, names,
 * `+ - * /`, unary minus, parentheses and the constant `pi`.
 */

/** Longest expression accepted (characters). */
export const VECTOR_EXPR_MAX_LENGTH = 1024;
/** Deepest nesting (parentheses, unary minus) and name reference chain. */
const MAX_DEPTH = 64;

export class VectorExprError extends Error {}

type Expr = { k: 'num'; v: number } | { k: 'var'; n: string } | { k: 'neg'; a: Expr } | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr };

/** A valid name: a letter or `_`, then letters, digits or `_` (not `pi`), at most 64 characters. */
export function isValidVectorParameterName(s: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && s.length <= 64 && s.toLowerCase() !== 'pi';
}

function parse(text: string): Expr {
	if (text.length > VECTOR_EXPR_MAX_LENGTH) throw new VectorExprError('expression too long or too deeply nested');
	if (!text.trim()) throw new VectorExprError('syntax error: empty expression');
	let i = 0;
	let depth = 0;
	const ws = () => {
		while (i < text.length && /\s/.test(text[i])) i++;
	};
	const peek = () => {
		ws();
		return text[i];
	};
	const enter = () => {
		if (++depth > MAX_DEPTH) throw new VectorExprError('expression too long or too deeply nested');
	};
	const sum = (): Expr => {
		enter();
		let e = product();
		for (let c = peek(); c === '+' || c === '-'; c = peek()) {
			i++;
			e = { k: 'bin', op: c, a: e, b: product() };
		}
		depth--;
		return e;
	};
	const product = (): Expr => {
		let e = unary();
		for (let c = peek(); c === '*' || c === '/'; c = peek()) {
			i++;
			e = { k: 'bin', op: c, a: e, b: unary() };
		}
		return e;
	};
	const unary = (): Expr => {
		const c = peek();
		if (c === '-' || c === '+') {
			i++;
			enter();
			const e = unary();
			depth--;
			return c === '-' ? { k: 'neg', a: e } : e;
		}
		return atom();
	};
	const atom = (): Expr => {
		const c = peek();
		if (c === '(') {
			i++;
			const e = sum();
			if (peek() !== ')') throw new VectorExprError('syntax error: missing `)`');
			i++;
			return e;
		}
		if (c !== undefined && /[0-9.]/.test(c)) {
			const m = /^(\d*\.?\d*)([eE][+-]?\d+)?/.exec(text.slice(i))!;
			i += m[0].length;
			const v = Number(m[0]);
			if (!m[1] || m[1] === '.' || !Number.isFinite(v) || /\..*\./.test(m[1])) throw new VectorExprError(`syntax error: bad number \`${m[0]}\``);
			if (text[i] === '.') throw new VectorExprError(`syntax error: bad number \`${m[0]}.\``);
			return { k: 'num', v };
		}
		if (c !== undefined && /[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z0-9_]+/.exec(text.slice(i))!;
			i += m[0].length;
			return m[0].toLowerCase() === 'pi' ? { k: 'num', v: Math.PI } : { k: 'var', n: m[0] };
		}
		if (c === undefined) throw new VectorExprError('syntax error: unexpected end');
		throw new VectorExprError(`syntax error: unexpected \`${c}\``);
	};
	const e = sum();
	if (peek() !== undefined) throw new VectorExprError(`syntax error: unexpected \`${text.slice(i).trim()}\``);
	return e;
}

function evalWith(e: Expr, lookup: (name: string) => number): number {
	let v: number;
	switch (e.k) {
		case 'num':
			v = e.v;
			break;
		case 'var':
			v = lookup(e.n);
			break;
		case 'neg':
			v = -evalWith(e.a, lookup);
			break;
		case 'bin': {
			const x = evalWith(e.a, lookup);
			const y = evalWith(e.b, lookup);
			if (e.op === '/' && y === 0) throw new VectorExprError('division by zero');
			v = e.op === '+' ? x + y : e.op === '-' ? x - y : e.op === '*' ? x * y : x / y;
		}
	}
	if (!Number.isFinite(v)) throw new VectorExprError('result is not a finite number');
	return v;
}

/** Checks an expression's syntax (throws a `VectorExprError` saying what is wrong). */
export function checkVectorExpression(text: string): void {
	parse(text);
}

/** Names an expression refers to. */
export function vectorExpressionNames(text: string): string[] {
	const out: string[] = [];
	const walk = (e: Expr) => {
		if (e.k === 'var') {
			if (!out.includes(e.n)) out.push(e.n);
		} else if (e.k === 'neg') walk(e.a);
		else if (e.k === 'bin') {
			walk(e.a);
			walk(e.b);
		}
	};
	walk(parse(text));
	return out;
}

/** Named expressions (parameters and dimensional constraint names), evaluated lazily with cycle detection. */
export class VectorExprEnv {
	private readonly exprs = new Map<string, string>();
	private readonly cache = new Map<string, number>();

	set(name: string, expr: string): void {
		this.exprs.set(name, expr);
		this.cache.clear();
	}

	has(name: string): boolean {
		return this.exprs.has(name);
	}

	/** The value of a name. */
	value(name: string, stack: string[] = []): number {
		const hit = this.cache.get(name);
		if (hit !== undefined) return hit;
		if (stack.includes(name)) throw new VectorExprError(`parameter \`${name}\` refers to itself`);
		if (stack.length >= MAX_DEPTH) throw new VectorExprError('expression too long or too deeply nested');
		const text = this.exprs.get(name);
		if (text === undefined) throw new VectorExprError(`unknown parameter \`${name}\``);
		const e = parse(text);
		stack.push(name);
		const v = evalWith(e, (n) => this.value(n, stack));
		stack.pop();
		this.cache.set(name, v);
		return v;
	}

	/** Evaluates a free expression against these names. */
	eval(text: string): number {
		return evalWith(parse(text), (n) => this.value(n, []));
	}
}

/** Evaluates an expression with no names. */
export function evalVectorExpression(text: string): number {
	return evalWith(parse(text), (n) => {
		throw new VectorExprError(`unknown parameter \`${n}\``);
	});
}

/** A value as an expression: up to 6 decimals, trailing zeros trimmed. */
export function formatVectorValue(v: number): string {
	const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	return !s || s === '-0' ? '0' : s;
}
