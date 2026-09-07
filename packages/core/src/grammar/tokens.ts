/**
 * Canonical regex patterns for prompt editing tokens.
 */
export const TEMPLATE_REGEX = /{{\s*([^}]+?)\s*}}/g;
export const VARIABLE_REGEX = /(?<!\{)\{([^{}]+)\}(?!\})/g;
export const INSTRUCTION_REGEX = /__(.+?)__/g;

// Backward-compatible camelCase aliases
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
  version: string | number;
  body: string;
  createdAt?: any;
  [key: string]: any;
}

export interface Template {
  id?: string;
  name: string;
  body?: string;
  latestVersion?: string | number;
  versions?: TemplateVersion[];
  color?: string;
  [key: string]: any;
}

export interface ColorGradient {
  from: string;
  to: string;
}
