export type FormulaTokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'CELL_REF'
  | 'RANGE'
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
  position: number;
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
      if (i < input.length && input[i] === quote) {
        i++; // skip closing quote
      }
      tokens.push({
        type: 'STRING',
        value: str,
        position: start + offset
      });
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
        position: start + offset
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

    // Single character operators: +, -, *, /, ^, &, =, <, >
    if (['+', '-', '*', '/', '^', '&', '=', '<', '>'].includes(char)) {
      tokens.push({ type: 'OPERATOR', value: char, position: i + offset });
      i++;
      continue;
    }

    // Identifiers, Cell references, and Ranges (e.g. SUM, A1, B2:B10, A:A)
    if (/[a-zA-Z_$]/.test(char)) {
      const start = i;
      while (i < input.length && /[a-zA-Z0-9_$.]/.test(input[i])) {
        i++;
      }
      const rawWord = input.slice(start, i);

      // Check if followed by colon indicating a range e.g. A1:B10 or A:A
      if (i < input.length && input[i] === ':') {
        const colonPos = i;
        i++; // skip colon
        const secondStart = i;
        while (i < input.length && /[a-zA-Z0-9_$.]/.test(input[i])) {
          i++;
        }
        const secondWord = input.slice(secondStart, i);
        if (secondWord.length > 0) {
          tokens.push({
            type: 'RANGE',
            value: `${rawWord}:${secondWord}`.toUpperCase(),
            position: start + offset
          });
          continue;
        } else {
          // Revert back
          i = colonPos;
        }
      }

      // Check for boolean literal
      const upper = rawWord.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({
          type: 'BOOLEAN',
          value: upper,
          position: start + offset
        });
        continue;
      }

      // Check for Cell Reference (e.g. A1, $B$12, AA100)
      if (/^\$?[A-Za-z]+\$?[0-9]+$/.test(rawWord)) {
        tokens.push({
          type: 'CELL_REF',
          value: upper.replace(/\$/g, ''),
          position: start + offset
        });
        continue;
      }

      // Function or generic identifier
      tokens.push({
        type: 'IDENTIFIER',
        value: upper,
        position: start + offset
      });
      continue;
    }

    // Skip unknown character
    i++;
  }

  tokens.push({ type: 'EOF', value: '', position: input.length + offset });
  return tokens;
}
