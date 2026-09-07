/**
 * Canonical regex patterns for prompt editing tokens.
 */
export const TEMPLATE_REGEX = /{{\s*([^}]+?)\s*}}/g;
export const VARIABLE_REGEX = /(?<!\{)\{([^{}]+)\}(?!\})/g;
export const INSTRUCTION_REGEX = /__(.+?)__/g;

// Backward-compatible alias matching SlopMachine naming
export const templateRegex = TEMPLATE_REGEX;
export const variableRegex = VARIABLE_REGEX;
export const instructionRegex = INSTRUCTION_REGEX;

export type TokenType = "template" | "variable" | "instruction" | "text";

export interface Token {
  type: TokenType;
  raw: string;
  value: string;
  start: number;
  end: number;
}

export interface TemplateVersion {
  id: string;
  version: string;
  body: string;
  createdAt?: string;
}

export interface Template {
  id?: string;
  name: string;
  body?: string;
  latestVersion?: string;
  versions?: TemplateVersion[];
  color?: string;
}

export interface ColorGradient {
  from: string;
  to: string;
}
