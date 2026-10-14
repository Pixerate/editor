export type FormulaTokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'ERROR'
  | 'CELL_REF'
  | 'RANGE'
  | 'SPILL_REF'
  | 'PROPERTY_REF'
  | 'IDENTIFIER'
  | 'OPERATOR'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'EOF';

export interface FormulaToken {
  type: FormulaTokenType;
  value: string;
  /** Offset of the token in the formula (for a sheet-qualified reference, of its sheet prefix). */
  position: number;
  /** Offset just past the token. */
  end?: number;
  /**
   * Sheet of a sheet-qualified reference or name (`Sheet2!A1`, `'My Sheet'!A1:B2`,
   * `Data!Rate`), unquoted. Unset for references to the formula's own sheet.
   */
  sheet?: string;
  /** Last sheet of a 3-D reference (`Sheet1:Sheet3!A1`). */
  sheetEnd?: string;
  /** Offset where the reference itself starts, after the sheet prefix and `!`. */
  refStart?: number;
}

// Excel sheet names are at most 31 characters; a quoted name doubles its
// apostrophes, so a quoted prefix is never longer than this. Bounding the
// look-ahead keeps tokenizing linear on input full of apostrophes.
const MAX_QUOTED_SHEET_LENGTH = 2 * 31 + 2;

const isWordStart = (char: string) => /[A-Za-z_$\\]/.test(char) || (char > '\u007f' && /\p{L}/u.test(char));
const isWordChar = (char: string) =>
  /[A-Za-z0-9_$.\\?]/.test(char) || (char > '\u007f' && /[\p{L}\p{N}]/u.test(char));
const CELL_WORD = /^\$?[A-Za-z]+\$?[0-9]+$/;

/**
 * A quoted sheet prefix starting at `start` (`'My Sheet'!`, `'Bob''s'!`,
 * `'Q1:Q4'!` for a 3-D span): the sheet name(s) and the offset after `!`, or
 * null when the quote does not open a sheet prefix (it is a string).
 */
function readQuotedSheet(input: string, start: number): { sheet: string; sheetEnd?: string; next: number } | null {
  let name = '';
  let j = start + 1;
  while (j < input.length && j - start <= MAX_QUOTED_SHEET_LENGTH) {
    if (input[j] === "'") {
      if (input[j + 1] === "'") {
        name += "'";
        j += 2;
        continue;
      }
      // `'text'!=1` is a comparison (`!=` is `<>`), not a sheet prefix.
      if (input[j + 1] !== '!' || input[j + 2] === '=' || name === '') return null;
      const colon = name.indexOf(':');
      if (colon > 0 && colon < name.length - 1) {
        return { sheet: name.slice(0, colon), sheetEnd: name.slice(colon + 1), next: j + 2 };
      }
      return { sheet: name, next: j + 2 };
    }
    name += input[j];
    j++;
  }
  return null;
}

export function tokenizeFormula(formula: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  // Strip leading '=' if present
  let input = formula.trim();
  let offset = 0;
  if (input.startsWith('=')) {
    input = input.slice(1);
    offset = 1;
  }

  let i = 0;
  while (i < input.length) {
    const char = input[i];

    // Skip whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Number literal (int or float)
    if (/\d/.test(char) || (char === '.' && i + 1 < input.length && /\d/.test(input[i + 1]))) {
      const start = i;
      let hasDot = char === '.';
      i++;
      while (i < input.length && (/\d/.test(input[i]) || (input[i] === '.' && !hasDot))) {
        if (input[i] === '.') hasDot = true;
        i++;
      }
      tokens.push({
        type: 'NUMBER',
        value: input.slice(start, i),
        position: start + offset
      });
      continue;
    }

    // Quoted sheet prefix: 'My Sheet'!A1
    if (char === "'") {
      const prefix = readQuotedSheet(input, i);
      if (prefix) {
        i = readQualifiedReference(input, prefix.next, i, prefix.sheet, prefix.sheetEnd, offset, tokens);
        continue;
      }
    }

    // String literal ("..." or '...')
    if (char === '"' || char === "'") {
      const quote = char;
      const start = i;
      i++;
      let str = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
        }
        str += input[i];
        i++;
      }
      if (i >= input.length) {
        throw new Error(`Unterminated string starting at position ${start + offset}`);
      }
      i++; // skip closing quote
      tokens.push({
        type: 'STRING',
        value: str,
        position: start + offset,
        end: i + offset
      });
      continue;
    }

    // Error literal, e.g. #REF! left behind by deleting a referenced row
    if (char === '#') {
      const match = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|CYCLE!|ERROR!|SPILL!|CALC!)/.exec(input.slice(i));
      if (!match) {
        throw new Error(`Unexpected character '#' at position ${i + offset}`);
      }
      tokens.push({ type: 'ERROR', value: match[0], position: i + offset });
      i += match[0].length;
      continue;
    }

    // Property reference: [property_name] e.g. [status], [title], [effortHours]
    if (char === '[') {
      const start = i;
      i++;
      let prop = '';
      while (i < input.length && input[i] !== ']') {
        prop += input[i];
        i++;
      }
      if (i < input.length && input[i] === ']') {
        i++;
      }
      tokens.push({
        type: 'PROPERTY_REF',
        value: prop.trim(),
        position: start + offset,
        end: i + offset
      });
      continue;
    }

    // Single character delimiters
    if (char === '(') {
      tokens.push({ type: 'LPAREN', value: '(', position: i + offset });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'RPAREN', value: ')', position: i + offset });
      i++;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'COMMA', value: ',', position: i + offset });
      i++;
      continue;
    }

    // Multi-character comparison operators: <=, >=, <>, !=
    const twoChars = input.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(twoChars)) {
      tokens.push({
        type: 'OPERATOR',
        value: twoChars === '!=' ? '<>' : twoChars,
        position: i + offset
      });
      i += 2;
      continue;
    }

    // Single character operators: +, -, *, /, ^, &, =, <, >, and @ (implicit intersection)
    if (['+', '-', '*', '/', '^', '&', '=', '<', '>', '@'].includes(char)) {
      tokens.push({ type: 'OPERATOR', value: char, position: i + offset });
      i++;
      continue;
    }

    // Identifiers, Cell references, and Ranges (e.g. SUM, A1, B2:B10, A:A),
    // optionally sheet-qualified (Sheet2!A1, Sheet1:Sheet3!A1).
    if (isWordStart(char)) {
      const start = i;
      while (i < input.length && isWordChar(input[i])) {
        i++;
      }
      const rawWord = input.slice(start, i);

      // Sheet prefix: Sheet2!A1 (but `A1!=B1` is a comparison).
      if (input[i] === '!' && input[i + 1] !== '=') {
        i = readQualifiedReference(input, i + 1, start, rawWord, undefined, offset, tokens);
        continue;
      }

      // Check if followed by colon indicating a range e.g. A1:B10 or A:A
      if (i < input.length && input[i] === ':') {
        const colonPos = i;
        i++; // skip colon
        const secondStart = i;
        while (i < input.length && isWordChar(input[i])) {
          i++;
        }
        const secondWord = input.slice(secondStart, i);
        if (secondWord.length > 0 && input[i] === '!' && input[i + 1] !== '=') {
          // 3-D reference: Sheet1:Sheet3!A1
          i = readQualifiedReference(input, i + 1, start, rawWord, secondWord, offset, tokens);
          continue;
        }
        if (secondWord.length > 0) {
          tokens.push({
            type: 'RANGE',
            value: `${rawWord}:${secondWord}`.toUpperCase(),
            position: start + offset,
            end: i + offset
          });
          continue;
        } else {
          // Revert back
          i = colonPos;
        }
      }

      pushWord(input, rawWord, start, i, offset, tokens);
      if (tokens[tokens.length - 1].type === 'SPILL_REF') i++;
      continue;
    }

    throw new Error(`Unexpected character '${char}' at position ${i + offset}`);
  }

  tokens.push({ type: 'EOF', value: '', position: input.length + offset, end: input.length + offset });
  for (const token of tokens) {
    if (token.end === undefined) token.end = token.position + Math.max(token.value.length, 1);
  }
  return tokens;
}

/**
 * Pushes the token for a word: a boolean, a cell reference (`A1`, `$B$2`),
 * a spill reference (`A1#`, when followed by `#`) or an identifier.
 */
function pushWord(
  input: string,
  rawWord: string,
  start: number,
  end: number,
  offset: number,
  tokens: FormulaToken[],
  qualified?: Pick<FormulaToken, 'sheet' | 'sheetEnd' | 'refStart' | 'position'>,
): void {
  const upper = rawWord.toUpperCase();
  const position = qualified?.position ?? start + offset;
  const extra = qualified ? { sheet: qualified.sheet, ...(qualified.sheetEnd ? { sheetEnd: qualified.sheetEnd } : {}), refStart: qualified.refStart } : {};
  if (!qualified && (upper === 'TRUE' || upper === 'FALSE')) {
    tokens.push({ type: 'BOOLEAN', value: upper, position, end: end + offset });
    return;
  }
  if (CELL_WORD.test(rawWord)) {
    // A1# is the whole spill range of the dynamic array anchored at A1.
    if (input[end] === '#') {
      tokens.push({ type: 'SPILL_REF', value: upper.replace(/\$/g, ''), position, end: end + 1 + offset, ...extra });
      return;
    }
    tokens.push({ type: 'CELL_REF', value: upper.replace(/\$/g, ''), position, end: end + offset, ...extra });
    return;
  }
  tokens.push({ type: 'IDENTIFIER', value: upper, position, end: end + offset, ...extra });
}

/**
 * Reads the reference after a sheet prefix (`A1`, `A1:B2`, `A:A`, `A1#` or a
 * defined name) starting at `from`, pushes its token and returns the offset
 * after it.
 */
function readQualifiedReference(
  input: string,
  from: number,
  prefixStart: number,
  sheet: string,
  sheetEnd: string | undefined,
  offset: number,
  tokens: FormulaToken[],
): number {
  let i = from;
  while (i < input.length && isWordChar(input[i])) i++;
  const word = input.slice(from, i);
  if (!word) throw new Error(`Expected a reference after '!' at position ${from + offset}`);
  const qualified = { sheet, sheetEnd, refStart: from + offset, position: prefixStart + offset };
  if (input[i] === ':') {
    let j = i + 1;
    while (j < input.length && isWordChar(input[j])) j++;
    const second = input.slice(i + 1, j);
    if (second) {
      tokens.push({
        type: 'RANGE',
        value: `${word}:${second}`.toUpperCase(),
        position: qualified.position,
        end: j + offset,
        sheet,
        ...(sheetEnd ? { sheetEnd } : {}),
        refStart: qualified.refStart,
      });
      return j;
    }
  }
  pushWord(input, word, from, i, offset, tokens, qualified);
  return tokens[tokens.length - 1].type === 'SPILL_REF' ? i + 1 : i;
}
