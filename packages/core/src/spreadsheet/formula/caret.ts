import {
  getFormulaArgumentSpecIndex,
  getFormulaFunction,
  getFormulaSignature,
  getFormulaSignatureParts,
  searchFormulaFunctions,
  type FormulaArgumentSpec,
  type FormulaFunctionDefinition,
  type FormulaSignaturePart,
} from './registry';

/**
 * Caret analysis for formula autocomplete. The input is scanned tolerantly
 * (unterminated strings and unbalanced parentheses are expected while typing),
 * so this never throws.
 */
export interface FormulaCaretContext {
  /** The function-name prefix being typed right before the caret, if any. */
  prefix: { text: string; start: number; end: number } | null;
  /** The innermost function call containing the caret, if any. */
  call: {
    name: string;
    /** 0-based index of the argument the caret is in. */
    argIndex: number;
    /** Offset of the call's opening parenthesis. */
    openParen: number;
  } | null;
}

const EMPTY: FormulaCaretContext = { prefix: null, call: null };

/** Determines what is being typed at `caret` in `input` (a formula starting with `=`). */
export function getFormulaCaretContext(input: string, caret: number = input.length): FormulaCaretContext {
  const leading = input.length - input.trimStart().length;
  if (input[leading] !== '=') return EMPTY;
  const end = Math.max(0, Math.min(caret, input.length));
  if (end <= leading) return EMPTY;

  const stack: Array<{ name: string | null; argIndex: number; openParen: number }> = [];
  let quote: string | null = null;
  let inProperty = false;

  for (let i = leading + 1; i < end; i++) {
    const char = input[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (inProperty) {
      if (char === ']') inProperty = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      inProperty = true;
    } else if (char === '(') {
      const name = /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(input.slice(leading + 1, i));
      const isFunction = name && !/^\$?[A-Za-z]+\$?\d+$/.test(name[1]) && !/[:$]$/.test(input.slice(0, i - name[0].length));
      stack.push({ name: isFunction ? name![1].toUpperCase() : null, argIndex: 0, openParen: i });
    } else if (char === ')') {
      stack.pop();
    } else if (char === ',' && stack.length > 0) {
      stack[stack.length - 1].argIndex++;
    }
  }

  if (quote || inProperty) {
    // Inside a string or [property]: no name completion, but keep the call hint.
    return { prefix: null, call: innermostCall(stack) };
  }

  let prefix: FormulaCaretContext['prefix'] = null;
  const before = input.slice(leading + 1, end);
  const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
  if (word) {
    const start = leading + 1 + word.index;
    const preceding = input[start - 1] ?? '';
    // Not a range end (A1:B), an absolute ref ($A) or part of a number (1E5).
    if (!/[:$0-9.]/.test(preceding)) {
      prefix = { text: word[0], start, end };
    }
  }

  return { prefix, call: innermostCall(stack) };
}

function innermostCall(stack: Array<{ name: string | null; argIndex: number; openParen: number }>) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame.name) return { name: frame.name, argIndex: frame.argIndex, openParen: frame.openParen };
  }
  return null;
}

/** A function suggestion for autocomplete. */
export interface FormulaFunctionSuggestion {
  name: string;
  signature: string;
  description: string;
  category: FormulaFunctionDefinition['category'];
}

export interface FormulaActiveCall {
  name: string;
  signature: string;
  description: string;
  /** Signature split into parts, with the active argument marked. */
  parts: FormulaSignaturePart[];
  /** 0-based argument index at the caret. */
  argIndex: number;
  /** Spec of the active argument, if the function takes an argument there. */
  argument: FormulaArgumentSpec | null;
}

export interface FormulaHints {
  context: FormulaCaretContext;
  /** Functions matching the name prefix at the caret (empty when not typing a name). */
  suggestions: FormulaFunctionSuggestion[];
  /** The known function whose arguments the caret is in. */
  activeCall: FormulaActiveCall | null;
}

const toSuggestion = (def: FormulaFunctionDefinition): FormulaFunctionSuggestion => ({
  name: def.name,
  signature: getFormulaSignature(def),
  description: def.description,
  category: def.category,
});

/** Everything formula autocomplete UIs need for `input` with the caret at `caret`. */
export function getFormulaHints(
  input: string,
  caret: number = input.length,
  options: { limit?: number } = {},
): FormulaHints {
  const context = getFormulaCaretContext(input, caret);
  let suggestions: FormulaFunctionSuggestion[] = [];
  if (context.prefix) {
    const query = context.prefix.text.toUpperCase();
    // Suggest names that start with what was typed; hide an exact, complete match.
    suggestions = searchFormulaFunctions(query, { limit: undefined })
      .filter((def) => def.name.startsWith(query))
      .slice(0, options.limit ?? 8)
      .map(toSuggestion);
    const followedByParen = input.slice(context.prefix.end).trimStart().startsWith('(');
    if (followedByParen || (suggestions.length === 1 && suggestions[0].name === query)) suggestions = [];
  }

  let activeCall: FormulaActiveCall | null = null;
  if (context.call) {
    const def = getFormulaFunction(context.call.name);
    if (def) {
      const specIndex = getFormulaArgumentSpecIndex(def, context.call.argIndex);
      activeCall = {
        name: def.name,
        signature: getFormulaSignature(def),
        description: def.description,
        parts: getFormulaSignatureParts(def, context.call.argIndex),
        argIndex: context.call.argIndex,
        argument: specIndex >= 0 ? def.args[specIndex] : null,
      };
    }
  }

  return { context, suggestions, activeCall };
}

/**
 * Replaces the name prefix at the caret with `NAME(`, returning the new input
 * and caret position (just inside the parenthesis).
 */
export function applyFormulaSuggestion(
  input: string,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const context = getFormulaCaretContext(input, caret);
  const start = context.prefix?.start ?? caret;
  const end = context.prefix?.end ?? caret;
  // Skip an existing "(" so accepting inside "SU|(" doesn't double it.
  const hasParen = input[end] === '(';
  const insert = hasParen ? name.toUpperCase() : `${name.toUpperCase()}(`;
  const value = input.slice(0, start) + insert + input.slice(end);
  return { value, caret: start + insert.length + (hasParen ? 1 : 0) };
}
