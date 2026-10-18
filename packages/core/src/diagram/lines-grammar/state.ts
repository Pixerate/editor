import type { LineGrammar, NodeDecl, EdgeSpec } from "./engine.js";
import { joinBraceBlocks } from "./engine.js";

/**
 * stateDiagram / stateDiagram-v2 grammar.
 *
 * Supported statements: transitions (`A --> B : label`), `state "desc" as A`,
 * `state A <<fork|join|choice>>`, composite `state A { … }`, `A : description`,
 * `[*]` start/end pseudo-states, `direction`, `classDef`, `class`, `style`,
 * `A:::cls`. Notes, concurrency separators (`--`) and anything else are kept
 * verbatim as passthrough statements.
 *
 * @module
 */

const ID = String.raw`[A-Za-z0-9_À-￿.-]+`;
const TRANSITION = new RegExp(
  String.raw`^(\[\*\]|${ID}(?::::${ID})?)\s*-->\s*(\[\*\]|${ID}(?::::${ID})?)\s*(?::\s*(.*))?$`,
);

export const STATE_SHAPES = [
  { name: "rect", title: "State" },
  { name: "fork", title: "Fork" },
  { name: "join", title: "Join" },
  { name: "choice", title: "Choice" },
] as const;

function splitClasses(token: string): { id: string; classes: string[] } {
  const [id, ...classes] = token.split(":::");
  return { id: id!, classes };
}

function quoteIfNeeded(label: string): string {
  return /[\s:{}"]/.test(label) || label === "" ? `"${label.replace(/"/g, "'")}"` : label;
}

export const stateGrammar: LineGrammar = {
  family: "state",
  defaultShape: "rect",
  directionAsStatement: true,
  defaultEdge: { arrowStart: "none", arrowEnd: "arrow_barb", pattern: "solid" },

  joinLines(lines) {
    // Multi-line notes: `note right of A` … `end note`
    return joinBraceBlocks(lines, {
      open: /^\s*note\s+(left|right)\s+of\s+\S+\s*$/i,
      close: /^\s*end\s+note\s*$/i,
    }).flatMap((logical) => {
      // Composite states are groups: keep `{` opener and `}` closer as their own lines.
      if (/^\s*state\b.*\{\s*$/.test(logical.split("\n")[0]!) && logical.includes("\n"))
        return logical.split("\n");
      return [logical];
    });
  },

  parseLine(line) {
    const indent = line.match(/^\s*/)![0];
    const text = line.trim();
    if (text === "" || text.startsWith("%%") || text.startsWith("note") || text === "--")
      return { kind: "raw", raw: line, indent };
    if (text === "}") return { kind: "groupClose", raw: line, indent };
    let m: RegExpExecArray | null;

    if ((m = /^direction\s+(TB|TD|BT|LR|RL)\s*$/i.exec(text)))
      return { kind: "direction", raw: line, indent, direction: m[1]!.toUpperCase() };
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "classDef",
        raw: line,
        indent,
        names: m[1]!.split(","),
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    if ((m = /^class\s+(\S+)\s+(\S+)\s*$/.exec(text)))
      return { kind: "class", raw: line, indent, ids: m[1]!.split(","), className: m[2]! };
    if ((m = /^style\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "style",
        raw: line,
        indent,
        id: m[1]!,
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };

    // state "Label" as A {   |  state A {
    if ((m = new RegExp(String.raw`^state\s+(?:"([^"]*)"\s+as\s+)?(${ID})\s*\{\s*$`).exec(text))) {
      return { kind: "groupOpen", raw: line, indent, id: m[2]!, label: m[1] };
    }
    // state "Label" as A   |  state A <<fork>>  | state A
    if (
      (m = new RegExp(
        String.raw`^state\s+(?:"([^"]*)"\s+as\s+)?(${ID})(?::::(${ID}))?(?:\s+<<(fork|join|choice|end)>>)?\s*$`,
      ).exec(text))
    ) {
      const decl: NodeDecl = { id: m[2]!, label: m[1], classes: m[3] ? [m[3]] : [] };
      if (m[4]) decl.shape = m[4] === "end" ? "stateEnd" : m[4];
      return { kind: "node", raw: line, indent, decl };
    }
    // Transition
    if ((m = TRANSITION.exec(text))) {
      const s = splitClasses(m[1]!);
      const t = splitClasses(m[2]!);
      return {
        kind: "edge",
        raw: line,
        indent,
        source: { id: s.id, classes: s.classes },
        target: { id: t.id, classes: t.classes },
        label: m[3]?.trim() || undefined,
        arrowStart: "none",
        arrowEnd: "arrow_barb",
        pattern: "solid",
      };
    }
    // A : description
    if ((m = new RegExp(String.raw`^(${ID})\s*:\s*(.*)$`).exec(text))) {
      return {
        kind: "node",
        raw: line,
        indent,
        decl: { id: m[1]!, classes: [], data: { descriptions: [m[2]!.trim()] } },
      };
    }
    // bare id (with optional :::class)
    if ((m = new RegExp(String.raw`^(${ID})(?::::(${ID}))?\s*$`).exec(text))) {
      return { kind: "node", raw: line, indent, decl: { id: m[1]!, classes: m[2] ? [m[2]] : [] } };
    }
    return { kind: "raw", raw: line, indent };
  },

  formatStatement(stmt) {
    switch (stmt.kind) {
      case "node": {
        const d = stmt.decl;
        const descriptions = d.data?.descriptions as string[] | undefined;
        if (descriptions?.length && d.label === undefined && !d.shape) {
          return `${stmt.indent}${d.id} : ${descriptions[0]}`;
        }
        let out = `${stmt.indent}state `;
        if (d.label !== undefined && d.label !== d.id) out += `"${d.label.replace(/"/g, "'")}" as `;
        out += d.id;
        for (const c of d.classes) out += `:::${c}`;
        if (d.shape && d.shape !== "rect")
          out += ` <<${d.shape === "stateEnd" ? "end" : d.shape}>>`;
        return out;
      }
      case "edge": {
        const fmt = (n: NodeDecl) => n.id + n.classes.map((c) => `:::${c}`).join("");
        const src = fmt(stmt.source);
        const tgt = fmt(stmt.target);
        return `${stmt.indent}${src} --> ${tgt}${stmt.label ? ` : ${stmt.label}` : ""}`;
      }
      case "groupOpen":
        return `${stmt.indent}state ${stmt.label !== undefined && stmt.label !== stmt.id ? `"${stmt.label}" as ` : ""}${stmt.id} {`;
      case "groupClose":
        return `${stmt.indent}}`;
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
    return {
      kind: "node",
      raw: "",
      indent,
      decl: { ...decl, classes: [...decl.classes] },
      dirty: true,
    };
  },

  edgeStatement(source, target, spec: EdgeSpec, indent) {
    const synthetic = (spec.data?.synthetic ?? {}) as { source?: boolean; target?: boolean };
    const endpoint = (id: string, isSynthetic: boolean | undefined): NodeDecl =>
      isSynthetic ? { id: "[*]", classes: [] } : { id, classes: [] };
    return {
      kind: "edge",
      raw: "",
      indent,
      source: endpoint(source, synthetic.source),
      target: endpoint(target, synthetic.target),
      label: spec.label,
      arrowStart: "none",
      arrowEnd: "arrow_barb",
      pattern: "solid",
      dirty: true,
    };
  },

  groupStatements(id, label, indent) {
    return {
      open: { kind: "groupOpen", raw: "", indent, id, label, dirty: true },
      close: { kind: "groupClose", raw: `${indent}}`, indent },
    };
  },

  headerDirection(_header, statements) {
    const top = statements.find((s) => s.kind === "direction");
    return top && top.kind === "direction" ? top.direction : "TB";
  },

  resolveEndpoint(id, stack, role) {
    if (id !== "[*]") return null;
    const scope = stack[stack.length - 1] ?? "root";
    return role === "source"
      ? { id: `${scope}_start`, shape: "stateStart", label: "", synthetic: true }
      : { id: `${scope}_end`, shape: "stateEnd", label: "", synthetic: true };
  },
};

export function quoteStateLabel(label: string): string {
  return quoteIfNeeded(label);
}
