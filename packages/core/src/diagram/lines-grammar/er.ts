import type { ArrowHead, EdgePattern } from "../types.js";
import type { LineGrammar, NodeDecl, EdgeSpec } from "./engine.js";
import { joinBraceBlocks } from "./engine.js";

/**
 * erDiagram grammar.
 *
 * Supported: relationships with crow's-foot cardinalities
 * (`A ||--o{ B : label`), entities with attribute blocks (kept verbatim and
 * parsed), aliases (`A[Alias]`), `direction`, `classDef`, `class`, `style`,
 * `A:::cls`. Word-form cardinalities (`one or more to …`) are passthrough.
 *
 * @module
 */

const ID = String.raw`[A-Za-z0-9_À-￿-]+|"[^"]+"`;

export const ER_CARDINALITIES: {
  token: string;
  head: ArrowHead;
  side: "left" | "right";
  title: string;
}[] = [
  { token: "|o", head: "zero_or_one", side: "left", title: "Zero or one" },
  { token: "||", head: "only_one", side: "left", title: "Exactly one" },
  { token: "}o", head: "zero_or_more", side: "left", title: "Zero or more" },
  { token: "}|", head: "one_or_more", side: "left", title: "One or more" },
  { token: "o|", head: "zero_or_one", side: "right", title: "Zero or one" },
  { token: "||", head: "only_one", side: "right", title: "Exactly one" },
  { token: "o{", head: "zero_or_more", side: "right", title: "Zero or more" },
  { token: "|{", head: "one_or_more", side: "right", title: "One or more" },
];

const LEFT: Record<string, ArrowHead> = {
  "|o": "zero_or_one",
  "||": "only_one",
  "}o": "zero_or_more",
  "}|": "one_or_more",
};
const RIGHT: Record<string, ArrowHead> = {
  "o|": "zero_or_one",
  "||": "only_one",
  "o{": "zero_or_more",
  "|{": "one_or_more",
};
const LEFT_TOKEN: Partial<Record<ArrowHead, string>> = {
  zero_or_one: "|o",
  only_one: "||",
  zero_or_more: "}o",
  one_or_more: "}|",
};
const RIGHT_TOKEN: Partial<Record<ArrowHead, string>> = {
  zero_or_one: "o|",
  only_one: "||",
  zero_or_more: "o{",
  one_or_more: "|{",
};

const RELATION = new RegExp(
  String.raw`^(${ID})(?:\[([^\]]*)\])?(?::::([\w-]+))?\s+(\|o|\|\||\}o|\}\|)(--|\.\.|\.-|-\.)(o\||\|\||o\{|\|\{)\s+(${ID})(?:\[([^\]]*)\])?(?::::([\w-]+))?\s*:\s*(.*)$`,
);

export interface ErAttribute {
  raw: string;
  type: string;
  name: string;
  keys: string[];
  comment?: string;
}

export function parseAttributes(bodyLines: string[]): ErAttribute[] {
  const out: ErAttribute[] = [];
  for (const line of bodyLines) {
    const t = line.trim();
    if (!t || t === "}" || t.startsWith("%%")) continue;
    const m =
      /^(\S+)\s+(\S+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)\s*(?:"([^"]*)")?\s*$/.exec(t);
    if (m) {
      out.push({
        raw: t,
        type: m[1]!,
        name: m[2]!,
        keys: (m[3] ?? "").split(/[\s,]+/).filter(Boolean),
        comment: m[4],
      });
    } else {
      out.push({ raw: t, type: "", name: t, keys: [] });
    }
  }
  return out;
}

function unq(id: string): string {
  return id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
}

function fmtId(id: string): string {
  return /[\s]/.test(id) ? `"${id}"` : id;
}

export const erGrammar: LineGrammar = {
  family: "er",
  defaultShape: "erBox",
  directionAsStatement: true,
  supportsGroups: false,
  defaultEdge: { arrowStart: "only_one", arrowEnd: "zero_or_more", pattern: "solid", label: "has" },

  joinLines(lines) {
    return joinBraceBlocks(lines);
  },

  parseLine(logical) {
    const [line, ...bodyRest] = logical.split("\n");
    const indent = line!.match(/^\s*/)![0];
    const text = line!.trim();
    if (text === "" || text.startsWith("%%")) return { kind: "raw", raw: logical, indent };
    let m: RegExpExecArray | null;

    if ((m = /^direction\s+(TB|TD|BT|LR|RL)\s*$/i.exec(text)))
      return { kind: "direction", raw: line!, indent, direction: m[1]!.toUpperCase() };
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "classDef",
        raw: line!,
        indent,
        names: m[1]!.split(","),
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    if ((m = /^class\s+(\S+)\s+(\S+)\s*$/.exec(text)))
      return { kind: "class", raw: line!, indent, ids: m[1]!.split(","), className: m[2]! };
    if ((m = /^style\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "style",
        raw: line!,
        indent,
        id: m[1]!,
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };

    if ((m = RELATION.exec(text))) {
      const line_ = m[5]!;
      return {
        kind: "edge",
        raw: line!,
        indent,
        source: { id: unq(m[1]!), label: m[2], classes: m[3] ? [m[3]] : [] },
        target: { id: unq(m[7]!), label: m[8], classes: m[9] ? [m[9]] : [] },
        label: unq(m[10]!.trim()),
        arrowStart: LEFT[m[4]!]!,
        arrowEnd: RIGHT[m[6]!]!,
        pattern: line_ === "--" ? "solid" : "dotted",
        data: { identifying: line_ === "--" },
      };
    }

    // Entity with attributes:  NAME["Label"]:::cls {
    if (
      (m = new RegExp(String.raw`^(${ID})(?:\[([^\]]*)\])?(?::::([\w-]+))?\s*(\{)?\s*$`).exec(text))
    ) {
      const decl: NodeDecl = {
        id: unq(m[1]!),
        label: m[2] !== undefined ? unq(m[2]) : undefined,
        classes: m[3] ? [m[3]] : [],
      };
      if (m[4]) {
        decl.data = { attributes: parseAttributes(bodyRest) };
        return { kind: "node", raw: line!, indent, decl, body: bodyRest };
      }
      return { kind: "node", raw: line!, indent, decl };
    }
    return { kind: "raw", raw: logical, indent };
  },

  formatStatement(stmt) {
    switch (stmt.kind) {
      case "node": {
        const d = stmt.decl;
        let out = `${stmt.indent}${fmtId(d.id)}`;
        if (d.label !== undefined && d.label !== d.id) out += `["${d.label}"]`;
        for (const c of d.classes) out += `:::${c}`;
        if (stmt.body) out += " {";
        return out;
      }
      case "edge": {
        const fmt = (n: NodeDecl) =>
          fmtId(n.id) +
          (n.label !== undefined ? `["${n.label}"]` : "") +
          n.classes.map((c) => `:::${c}`).join("");
        const l = LEFT_TOKEN[stmt.arrowStart] ?? "||";
        const r = RIGHT_TOKEN[stmt.arrowEnd] ?? "o{";
        const mid = stmt.pattern === "dotted" ? ".." : "--";
        const label = stmt.label ?? "";
        return `${stmt.indent}${fmt(stmt.source)} ${l}${mid}${r} ${fmt(stmt.target)} : ${/\s/.test(label) ? `"${label}"` : label || '""'}`;
      }
      case "direction":
        return `${stmt.indent}direction ${stmt.direction}`;
      case "classDef":
        return `${stmt.indent}classDef ${stmt.names.join(",")} ${stmt.styles.join(",")}`;
      case "class":
        return `${stmt.indent}class ${stmt.ids.join(",")} ${stmt.className}`;
      case "style":
        return `${stmt.indent}style ${stmt.id} ${stmt.styles.join(",")}`;
      default:
        return stmt.raw;
    }
  },

  nodeStatement(decl, indent) {
    const attrs = decl.data?.attributes as ErAttribute[] | undefined;
    const body = attrs?.length
      ? [...attrs.map((a) => `${indent}  ${a.raw}`), `${indent}}`]
      : undefined;
    return {
      kind: "node",
      raw: "",
      indent,
      decl: { ...decl, classes: [...decl.classes] },
      body,
      dirty: true,
    };
  },

  edgeStatement(source, target, spec: EdgeSpec, indent) {
    return {
      kind: "edge",
      raw: "",
      indent,
      source: { id: source, classes: [] },
      target: { id: target, classes: [] },
      label: spec.label ?? "has",
      arrowStart: spec.arrowStart,
      arrowEnd: spec.arrowEnd,
      pattern: spec.pattern,
      data: spec.data,
      dirty: true,
    };
  },

  groupStatements(id, _label, indent) {
    // ER diagrams have no grouping construct; emit a comment pair so the
    // engine's bookkeeping still works and Mermaid ignores it.
    return {
      open: { kind: "raw", raw: `${indent}%% group ${id}`, indent },
      close: { kind: "raw", raw: `${indent}%% end group ${id}`, indent },
    };
  },

  headerDirection(_header, statements) {
    const top = statements.find((s) => s.kind === "direction");
    return top && top.kind === "direction" ? top.direction : "TB";
  },
};

export const ER_PATTERNS: { pattern: EdgePattern; title: string }[] = [
  { pattern: "solid", title: "Identifying" },
  { pattern: "dotted", title: "Non-identifying" },
];
