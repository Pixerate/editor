import type { EditOp, GraphEdge, MermaidDocument } from "../types.js";
import { type FlowchartBody, parseFlowchart, compoundInfo, markCompound } from "./parse.js";
import { serializeFlowchart, detectIndent } from "./serialize.js";
import { splitSource } from "../source/lines.js";
import {
  defaultCarrierFor,
  extractMetaFromBody,
  extractMetaFromFrontmatter,
  emptyMeta,
  mergeMeta,
} from "../source/metadata.js";
import type { Chain, FlowStatement, LinkRef, NodeRef } from "./statements.js";
import { canonicalShape } from "./shapes.js";

type Doc = MermaidDocument<FlowchartBody>;
type ChainStmt = Extract<FlowStatement, { kind: "chain" }>;
type SubgraphStmt = Extract<FlowStatement, { kind: "subgraph" }>;

/**
 * Applies an edit to a flowchart document. Statements are mutated in place
 * on a shallow copy, the document is re-serialised and re-parsed so that the
 * returned model is always consistent with its text.
 */
export function applyFlowchartEdit(doc: Doc, op: EditOp): Doc {
  if (op.type === "removeEdges" && op.ids.length > 1) return removeEdgesOneByOne(doc, op.ids);
  const statements = cloneStatements(doc.body.statements);
  const work: Doc = {
    ...doc,
    body: { statements },
    meta: { ...doc.meta, layout: { ...doc.meta.layout }, sizes: { ...doc.meta.sizes } },
  };
  const indent = detectIndent(statements);

  switch (op.type) {
    case "moveNodes":
      for (const { id, position } of op.moves) work.meta.layout![id] = position;
      return reparse(work, false);
    case "resizeNode":
      if (op.size) work.meta.sizes![op.id] = op.size;
      else delete work.meta.sizes![op.id];
      return reparse(work, false);
    case "setViewport":
      work.meta.viewport = op.viewport;
      return reparse(work, false);
    case "setMetaExt":
      work.meta.ext = { ...(work.meta.ext ?? {}), [op.key]: op.value };
      if (op.value === undefined) delete work.meta.ext[op.key];
      return reparse(work, false);
    case "setDirection":
      work.header = setHeaderDirection(work.header, op.direction);
      return reparse(work, true);
    case "setTitle":
      work.preamble = {
        ...work.preamble,
        lines: setFrontmatterTitle(work.preamble.lines, op.title),
      };
      return reparse(work, true);
    case "replaceSource":
      return parseFlowchartSource(op.source, work.metaCarrier);
    default:
      break;
  }

  // Structural edits below.
  switch (op.type) {
    case "addNode": {
      const ref: NodeRef = {
        id: op.node.id,
        label: op.node.label ?? op.node.id,
        shape: canonicalShape(op.node.shape ?? "rect"),
        form: "bracket",
        classes: [...(op.node.classes ?? [])],
      };
      const data = shapeDataFor(ref.shape!, encodeData(op.node.data));
      if (Object.keys(data).length) {
        ref.form = "data";
        ref.data = data;
      }
      const stmt: ChainStmt = {
        kind: "chain",
        raw: "",
        indent,
        chain: { groups: [[ref]], links: [] },
        dirty: true,
      };
      insertIntoGroup(statements, stmt, op.node.parentId, indent);
      if (op.position) work.meta.layout![op.node.id] = op.position;
      if (op.node.styles?.length) {
        statements.push({
          kind: "style",
          raw: "",
          indent,
          id: op.node.id,
          styles: [...op.node.styles],
          dirty: true,
        });
      }
      break;
    }
    case "removeNodes": {
      const ids = new Set(op.ids.filter((id) => !doc.graph.groups.some((g) => g.id === id)));
      // Group ids: drop the subgraph wrapper, keep its content (same as `ungroup`).
      for (const gid of op.ids.filter((id) => doc.graph.groups.some((g) => g.id === id))) {
        const range = groupRange(statements, gid);
        if (!range) continue;
        statements.splice(range.end, 1);
        statements.splice(range.start, 1);
        delete work.meta.layout![gid];
        delete work.meta.sizes![gid];
      }
      const removedEdgeOrdinals = edgeOrdinalsTouching(
        doc.graph.edges,
        (e) => ids.has(e.source) || ids.has(e.target),
      );
      removeNodesFromStatements(statements, ids);
      dropRedundantBareMentions(statements);
      // Drop class/style/click statements for removed nodes.
      filterInPlace(statements, (s) => {
        if (s.kind === "style" || s.kind === "click") return !ids.has(s.id);
        if (s.kind === "class") {
          s.ids = s.ids.filter((id) => !ids.has(id));
          if (!s.ids.length) return false;
          s.dirty = true;
          return true;
        }
        return true;
      });
      adjustLinkStyles(statements, removedEdgeOrdinals);
      for (const id of ids) {
        delete work.meta.layout![id];
        delete work.meta.sizes![id];
      }
      break;
    }
    case "renameNode": {
      const ref = declaringRef(statements, op.id, "label") ?? firstRef(statements, op.id);
      if (!ref) break;
      const node = doc.graph.nodes.find((n) => n.id === op.id);
      if (ref.ref.label === undefined) {
        ref.ref.shape = ref.ref.shape ?? node?.shape ?? "rect";
        ref.ref.form = ref.ref.form ?? "bracket";
      }
      ref.ref.label = op.label;
      ref.ref.labelQuoted = undefined;
      ref.stmt.dirty = true;
      break;
    }
    case "setNodeShape": {
      const shape = canonicalShape(op.shape);
      const ref = declaringRef(statements, op.id, "shape") ?? firstRef(statements, op.id);
      if (!ref) break;
      const node = doc.graph.nodes.find((n) => n.id === op.id);
      ref.ref.shape = shape;
      if (ref.ref.label === undefined) ref.ref.label = node?.label ?? op.id;
      ref.ref.form = ref.ref.form ?? "bracket";
      const data = shapeDataFor(shape, ref.ref.data ?? {});
      if (Object.keys(data).length) ref.ref.form = "data";
      ref.ref.data = Object.keys(data).length ? data : undefined;
      ref.stmt.dirty = true;
      break;
    }
    case "setNodeClasses": {
      // Clear existing `:::` and `class` references.
      for (const s of statements) {
        if (s.kind === "chain") {
          for (const g of s.chain.groups) {
            for (const r of g) {
              if (r.id === op.id && r.classes.length) {
                r.classes = [];
                s.dirty = true;
              }
            }
          }
        }
      }
      filterInPlace(statements, (s) => {
        if (s.kind !== "class") return true;
        if (!s.ids.includes(op.id)) return true;
        s.ids = s.ids.filter((id) => id !== op.id);
        s.dirty = true;
        return s.ids.length > 0;
      });
      const [first, ...rest] = op.classes;
      if (first) {
        const ref = declaringRef(statements, op.id, "label") ?? firstRef(statements, op.id);
        if (ref) {
          ref.ref.classes = [first];
          ref.stmt.dirty = true;
        }
      }
      for (const cls of rest)
        statements.push({
          kind: "class",
          raw: "",
          indent,
          ids: [op.id],
          className: cls,
          dirty: true,
        });
      break;
    }
    case "setNodeStyles": {
      filterInPlace(statements, (s) => !(s.kind === "style" && s.id === op.id));
      if (op.styles.length)
        statements.push({
          kind: "style",
          raw: "",
          indent,
          id: op.id,
          styles: [...op.styles],
          dirty: true,
        });
      break;
    }
    case "setNodeLink": {
      filterInPlace(statements, (s) => !(s.kind === "click" && s.id === op.id));
      if (op.link) {
        const parts = [`href "${op.link}"`];
        if (op.tooltip) parts.push(`"${op.tooltip}"`);
        if (op.target) parts.push(op.target);
        statements.push({
          kind: "click",
          raw: "",
          indent,
          id: op.id,
          rest: parts.join(" "),
          dirty: true,
        });
      }
      break;
    }
    case "setNodeData": {
      const ref = declaringRef(statements, op.id, "label") ?? firstRef(statements, op.id);
      if (!ref) break;
      const node = doc.graph.nodes.find((n) => n.id === op.id);
      ref.ref.form = "data";
      ref.ref.shape = ref.ref.shape ?? node?.shape ?? "rect";
      if (ref.ref.label === undefined) ref.ref.label = node?.label ?? op.id;
      const data = { ...(ref.ref.data ?? {}) };
      for (const [k, v] of Object.entries(op.data)) {
        if (v === undefined || v === null) delete data[k];
        else data[k] = typeof v === "string" ? JSON.stringify(v) : String(v);
      }
      ref.ref.data = data;
      ref.stmt.dirty = true;
      break;
    }
    case "addEdge": {
      const link: LinkRef = {
        id: op.edge.userDefinedId ? op.edge.id : undefined,
        pattern: op.edge.pattern ?? "solid",
        arrowStart: op.edge.arrowStart ?? "none",
        arrowEnd: op.edge.arrowEnd ?? "arrow_point",
        length: op.edge.length ?? 1,
        label: op.edge.label || undefined,
        labelStyle: op.edge.label ? "pipe" : undefined,
      };
      const stmt: ChainStmt = {
        kind: "chain",
        raw: "",
        indent,
        chain: {
          groups: [[{ id: op.edge.source, classes: [] }], [{ id: op.edge.target, classes: [] }]],
          links: [link],
        },
        dirty: true,
      };
      // Appending at top level never changes subgraph membership.
      appendAtEnd(statements, stmt);
      if (op.edge.styles?.length) {
        statements.push({
          kind: "linkStyle",
          raw: "",
          indent,
          targets: [doc.graph.edges.length],
          styles: [...op.edge.styles],
          dirty: true,
        });
      }
      break;
    }
    case "removeEdges": {
      const ids = new Set(op.ids);
      const removedOrdinals = edgeOrdinalsTouching(doc.graph.edges, (e) => ids.has(e.id));
      for (const edge of doc.graph.edges) {
        if (!ids.has(edge.id)) continue;
        const located = locateEdge(statements, doc.graph.edges, edge.id);
        if (!located) continue;
        removeLinkFromChain(
          statements,
          located.stmt,
          located.linkIndex,
          located.source,
          located.target,
          indent,
        );
      }
      adjustLinkStyles(statements, removedOrdinals);
      break;
    }
    case "setEdgeLabel":
    case "setEdgeStyle":
    case "reconnectEdge": {
      const located = locateEdge(statements, doc.graph.edges, op.id);
      if (!located) break;
      const stmt = isolateEdge(
        statements,
        located.stmt,
        located.linkIndex,
        located.source,
        located.target,
        indent,
      );
      const link = stmt.chain.links[0]!;
      if (op.type === "setEdgeLabel") {
        link.label = op.label || undefined;
        if (link.label && !link.labelStyle) link.labelStyle = "pipe";
      } else if (op.type === "setEdgeStyle") {
        if (op.pattern) link.pattern = op.pattern;
        if (op.arrowStart) link.arrowStart = op.arrowStart;
        if (op.arrowEnd) link.arrowEnd = op.arrowEnd;
        if (op.length) link.length = op.length;
        if (op.styles) {
          const ordinal = doc.graph.edges.findIndex((e) => e.id === op.id);
          setLinkStyleFor(statements, ordinal, op.styles, indent);
        }
      } else {
        stmt.chain.groups[0] = [{ id: op.source, classes: [] }];
        stmt.chain.groups[1] = [{ id: op.target, classes: [] }];
      }
      stmt.dirty = true;
      break;
    }
    case "groupNodes": {
      const open: SubgraphStmt = {
        kind: "subgraph",
        raw: "",
        indent,
        id: op.groupId,
        title: op.label,
        titleForm: "bracket",
        dirty: true,
      };
      const members: FlowStatement[] = op.nodeIds.map((id) => ({
        kind: "chain" as const,
        raw: "",
        indent: indent + indent,
        chain: { groups: [[{ id, classes: [] }]], links: [] },
        dirty: true,
      }));
      const block: FlowStatement[] = [
        open,
        ...members,
        { kind: "end", raw: `${indent}end`, indent },
      ];
      if (op.parentId) insertManyIntoGroup(statements, block, op.parentId, indent);
      else statements.push(...block);
      break;
    }
    case "ungroup": {
      const range = groupRange(statements, op.groupId);
      if (!range) break;
      const openIndent = (statements[range.start] as SubgraphStmt).indent;
      const inner = openIndent + indent;
      for (let i = range.start + 1; i < range.end; i++) {
        const s = statements[i]!;
        if (s.kind === "raw" || s.kind === "end") {
          if (s.raw.startsWith(inner))
            (s as { raw: string }).raw = openIndent + s.raw.slice(inner.length);
          continue;
        }
        if (s.indent.startsWith(inner)) {
          s.indent = openIndent + s.indent.slice(inner.length);
          s.dirty = true;
        }
      }
      statements.splice(range.end, 1);
      statements.splice(range.start, 1);
      // Remove direction statements that belonged to the group.
      for (let i = range.start; i < range.end - 1; i++) {
        const s = statements[i];
        if (
          s &&
          s.kind === "direction" &&
          depthAt(statements, i) === depthAt(statements, range.start)
        ) {
          statements.splice(i, 1);
          break;
        }
      }
      delete work.meta.layout![op.groupId];
      delete work.meta.sizes![op.groupId];
      break;
    }
    case "renameGroup": {
      const range = groupRange(statements, op.id);
      if (!range) break;
      const open = statements[range.start] as SubgraphStmt;
      open.title = op.label;
      if (open.titleForm === "none") open.titleForm = "bracket";
      if (open.titleForm === "bare") {
        // `subgraph Title` uses the title as id; switch to id [title] to keep the id stable.
        open.titleForm = "bracket";
      }
      open.dirty = true;
      break;
    }
    case "setGroupDirection": {
      const range = groupRange(statements, op.id);
      if (!range) break;
      let found = -1;
      for (let i = range.start + 1; i < range.end; i++) {
        const s = statements[i]!;
        if (
          s.kind === "direction" &&
          depthAt(statements, i) === depthAt(statements, range.start) + 1
        ) {
          found = i;
          break;
        }
      }
      if (op.direction) {
        if (found !== -1) {
          const s = statements[found] as Extract<FlowStatement, { kind: "direction" }>;
          s.direction = op.direction;
          s.dirty = true;
        } else {
          const inner = (statements[range.start] as SubgraphStmt).indent + indent;
          statements.splice(range.start + 1, 0, {
            kind: "direction",
            raw: "",
            indent: inner,
            direction: op.direction,
            dirty: true,
          });
        }
      } else if (found !== -1) {
        statements.splice(found, 1);
      }
      break;
    }
    case "setNodeParent": {
      for (const id of op.ids) {
        // Remove bare declarations (single-node chains) so the new mention is last.
        const bare = statements
          .map((s, i) => ({ s, i }))
          .filter(
            ({ s }) =>
              s.kind === "chain" &&
              s.chain.links.length === 0 &&
              s.chain.groups[0]!.length === 1 &&
              s.chain.groups[0]![0]!.id === id,
          );
        let decl: NodeRef | undefined;
        for (const { s, i } of bare.reverse()) {
          const ref = (s as ChainStmt).chain.groups[0]![0]!;
          if (ref.label !== undefined || ref.shape) decl = { ...ref };
          statements.splice(i, 1);
        }
        if (op.parentId) {
          const ref: NodeRef = decl ?? { id, classes: [] };
          const stmt: ChainStmt = {
            kind: "chain",
            raw: "",
            indent,
            chain: { groups: [[ref]], links: [] },
            dirty: true,
          };
          insertIntoGroup(statements, stmt, op.parentId, indent);
        } else if (decl) {
          appendAtEnd(statements, {
            kind: "chain",
            raw: "",
            indent,
            chain: { groups: [[decl]], links: [] },
            dirty: true,
          });
        }
      }
      break;
    }
    case "setClassDef": {
      let found = false;
      for (const s of statements) {
        if (s.kind !== "classDef") continue;
        if (s.names.length === 1 && s.names[0] === op.name) {
          found = true;
          if (op.styles) {
            s.styles = [...op.styles];
            s.dirty = true;
          }
        } else if (s.names.includes(op.name) && op.styles) {
          s.names = s.names.filter((n) => n !== op.name);
          s.dirty = true;
        }
      }
      if (!op.styles)
        filterInPlace(
          statements,
          (s) => !(s.kind === "classDef" && s.names.length === 1 && s.names[0] === op.name),
        );
      else if (!found)
        statements.push({
          kind: "classDef",
          raw: "",
          indent,
          names: [op.name],
          styles: [...op.styles],
          dirty: true,
        });
      break;
    }
    default:
      break;
  }

  return reparse(work, true);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clones statements and re-links compound (`a; b`) groups onto the clones. */
function cloneStatements(statements: FlowStatement[]): FlowStatement[] {
  const clones = statements.map(cloneStatement);
  const index = new Map(statements.map((s, i) => [s, i]));
  const done = new Set<FlowStatement>();
  statements.forEach((original) => {
    const info = compoundInfo(original);
    if (!info || done.has(original)) return;
    const members = info.members.map((m) => clones[index.get(m)!]!);
    info.members.forEach((m, j) => {
      done.add(m);
      markCompound(members[j]!, members, j === 0 ? info.raw : "");
    });
  });
  return clones;
}

function cloneStatement(s: FlowStatement): FlowStatement {
  if (s.kind === "chain") {
    return {
      ...s,
      chain: {
        groups: s.chain.groups.map((g) =>
          g.map((r) => ({
            ...r,
            classes: [...r.classes],
            data: r.data ? { ...r.data } : undefined,
          })),
        ),
        links: s.chain.links.map((l) => ({ ...l })),
      },
    };
  }
  if (s.kind === "classDef") return { ...s, names: [...s.names], styles: [...s.styles] };
  if (s.kind === "class") return { ...s, ids: [...s.ids] };
  if (s.kind === "style") return { ...s, styles: [...s.styles] };
  if (s.kind === "linkStyle")
    return {
      ...s,
      targets: s.targets === "default" ? "default" : [...s.targets],
      styles: [...s.styles],
    };
  return { ...s };
}

function reparse(work: Doc, structural: boolean): Doc {
  const text = serializeFlowchart(work);
  const next = parseFlowchartSource(text, work.metaCarrier);
  next.dirty = doc_dirty(work, structural);
  return next;
}

function doc_dirty(work: Doc, structural: boolean): boolean {
  return work.dirty || structural;
}

/** Full parse of a flowchart source, used after edits. */
export function parseFlowchartSource(source: string, carrier?: Doc["metaCarrier"]): Doc {
  const split = splitSource(source);
  const fromBody = extractMetaFromBody(split.bodyLines);
  const fromFm = extractMetaFromFrontmatter(split.preamble);
  let meta = emptyMeta();
  if (fromFm) meta = mergeMeta(meta, fromFm);
  if (fromBody.meta) meta = mergeMeta(meta, fromBody.meta);
  return parseFlowchart(source, {
    source,
    eol: split.eol,
    preamble: split.preamble,
    header: split.header,
    bodyLines: fromBody.bodyLines,
    trailing: split.trailing,
    meta,
    metaCarrier:
      carrier ?? (fromFm && !fromBody.meta ? "frontmatter" : defaultCarrierFor("flowchart")),
    family: "flowchart",
  });
}

function filterInPlace<T>(arr: T[], keep: (item: T) => boolean): void {
  let j = 0;
  for (let i = 0; i < arr.length; i++) {
    if (keep(arr[i]!)) arr[j++] = arr[i]!;
  }
  arr.length = j;
}

function setHeaderDirection(header: string, direction: string): string {
  const m = /^(\s*)(flowchart|graph)(-elk)?\b/i.exec(header);
  if (!m) return header;
  const keyword = `${m[2]}${m[3] ?? ""}`;
  const trailingSemi = /;\s*$/.test(header) ? ";" : "";
  return `${m[1]}${keyword} ${direction}${trailingSemi}`;
}

function setFrontmatterTitle(lines: string[], title: string | undefined): string[] {
  const out = [...lines];
  const hasFm = out[0] !== undefined && /^---\s*$/.test(out[0]);
  if (!hasFm) {
    if (title === undefined) return out;
    return ["---", `title: ${title}`, "---", ...out];
  }
  const close = out.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  const end = close === -1 ? out.length : close;
  const idx = out.findIndex((l, i) => i > 0 && i < end && /^title\s*:/.test(l));
  if (title === undefined) {
    if (idx !== -1) out.splice(idx, 1);
    const close2 = out.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (close2 === 1) out.splice(0, 2);
    return out;
  }
  if (idx !== -1) out[idx] = `title: ${title}`;
  else out.splice(end, 0, `title: ${title}`);
  return out;
}

/** 0-based nesting depth before statement `index`. */
function depthAt(statements: FlowStatement[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const s = statements[i]!;
    if (s.kind === "subgraph") depth++;
    else if (s.kind === "end") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Index range [start, end] of a subgraph's open/`end` statements. */
function groupRange(
  statements: FlowStatement[],
  groupId: string,
): { start: number; end: number } | null {
  const start = statements.findIndex((s) => s.kind === "subgraph" && s.id === groupId);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < statements.length; i++) {
    const s = statements[i]!;
    if (s.kind === "subgraph") depth++;
    else if (s.kind === "end") {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return { start, end: statements.length };
}

/** Appends a statement at the top level, before trailing classDef/style blocks if present. */
function appendAtEnd(statements: FlowStatement[], stmt: FlowStatement): void {
  statements.push(stmt);
}

function insertIntoGroup(
  statements: FlowStatement[],
  stmt: FlowStatement,
  groupId: string | undefined,
  indent: string,
): void {
  insertManyIntoGroup(statements, [stmt], groupId, indent);
}

function insertManyIntoGroup(
  statements: FlowStatement[],
  block: FlowStatement[],
  groupId: string | undefined,
  indent: string,
): void {
  const range = groupId ? groupRange(statements, groupId) : null;
  if (!range) {
    statements.push(...block);
    return;
  }
  const open = statements[range.start] as SubgraphStmt;
  const inner = open.indent + indent;
  for (const s of block)
    if ("indent" in s)
      (s as { indent: string }).indent =
        inner + (s as { indent: string }).indent.slice(indent.length);
  statements.splice(range.end, 0, ...block);
}

interface RefLocation {
  stmt: ChainStmt;
  ref: NodeRef;
}

function declaringRef(
  statements: FlowStatement[],
  id: string,
  prop: "label" | "shape",
): RefLocation | null {
  for (const s of statements) {
    if (s.kind !== "chain") continue;
    for (const g of s.chain.groups) {
      for (const r of g) {
        if (r.id === id && r[prop] !== undefined) return { stmt: s, ref: r };
      }
    }
  }
  return null;
}

function firstRef(statements: FlowStatement[], id: string): RefLocation | null {
  for (const s of statements) {
    if (s.kind !== "chain") continue;
    for (const g of s.chain.groups) for (const r of g) if (r.id === id) return { stmt: s, ref: r };
  }
  return null;
}

function edgeOrdinalsTouching(edges: GraphEdge[], predicate: (e: GraphEdge) => boolean): number[] {
  const out: number[] = [];
  edges.forEach((e, i) => {
    if (predicate(e)) out.push(i);
  });
  return out;
}

/** Re-indexes `linkStyle` statements after edges were removed. */
function adjustLinkStyles(statements: FlowStatement[], removedOrdinals: number[]): void {
  if (!removedOrdinals.length) return;
  const removed = new Set(removedOrdinals);
  filterInPlace(statements, (s) => {
    if (s.kind !== "linkStyle" || s.targets === "default") return true;
    const next = s.targets
      .filter((t) => !removed.has(t))
      .map((t) => t - removedOrdinals.filter((r) => r < t).length);
    if (next.length !== s.targets.length || next.some((t, i) => t !== s.targets[i])) {
      s.targets = next;
      s.dirty = true;
    }
    return next.length > 0;
  });
}

function setLinkStyleFor(
  statements: FlowStatement[],
  ordinal: number,
  styles: string[],
  indent: string,
): void {
  if (ordinal < 0) return;
  // Remove the ordinal from existing statements, then add a dedicated one.
  filterInPlace(statements, (s) => {
    if (s.kind !== "linkStyle" || s.targets === "default") return true;
    if (!s.targets.includes(ordinal)) return true;
    s.targets = s.targets.filter((t) => t !== ordinal);
    s.dirty = true;
    return s.targets.length > 0;
  });
  if (styles.length)
    statements.push({
      kind: "linkStyle",
      raw: "",
      indent,
      targets: [ordinal],
      styles: [...styles],
      dirty: true,
    });
}

interface EdgeLocation {
  stmt: ChainStmt;
  linkIndex: number;
  source: string;
  target: string;
}

/**
 * Finds the chain statement and link index that produced a graph edge, by
 * replaying the edge ordinal assignment of {@link buildGraph}.
 */
function locateEdge(
  statements: FlowStatement[],
  edges: GraphEdge[],
  edgeId: string,
): EdgeLocation | null {
  const target = edges.find((e) => e.id === edgeId);
  if (!target) return null;
  const ordinal = edges.indexOf(target);
  let n = 0;
  for (const s of statements) {
    if (s.kind !== "chain") continue;
    const { groups, links } = s.chain;
    if (
      groups.length === 1 &&
      groups[0]!.length === 1 &&
      links.length === 0 &&
      isEdgeDataStatement(groups[0]![0]!)
    )
      continue;
    for (let i = 0; i < links.length; i++) {
      for (const from of groups[i]!) {
        for (const to of groups[i + 1]!) {
          if (n === ordinal) return { stmt: s, linkIndex: i, source: from.id, target: to.id };
          n++;
        }
      }
    }
  }
  return null;
}

function isEdgeDataStatement(ref: NodeRef): boolean {
  return (
    ref.form === "data" &&
    !!ref.data &&
    !ref.shape &&
    ref.label === undefined &&
    ("animate" in ref.data || "animation" in ref.data)
  );
}

/**
 * Rewrites a chain so that the given link/pair lives in its own two-node
 * statement, returning that statement. Other pairs and declarations are kept.
 */
function isolateEdge(
  statements: FlowStatement[],
  stmt: ChainStmt,
  linkIndex: number,
  source: string,
  target: string,
  indent: string,
): ChainStmt {
  const { groups, links } = stmt.chain;
  const simple = groups.length === 2 && groups[0]!.length === 1 && groups[1]!.length === 1;
  if (simple) return stmt;
  const expanded = expandChain(stmt.chain);
  const idx = statements.indexOf(stmt);
  const out: ChainStmt[] = expanded.map((chain) => ({
    kind: "chain",
    raw: "",
    indent: stmt.indent || indent,
    chain,
    dirty: true,
  }));
  statements.splice(idx, 1, ...out);
  const found = out.find(
    (s) =>
      s.chain.links.length === 1 &&
      s.chain.groups[0]![0]!.id === source &&
      s.chain.groups[1]![0]!.id === target &&
      sameLink(s.chain.links[0]!, links[linkIndex]!),
  );
  return found ?? out[0]!;
}

function sameLink(a: LinkRef, b: LinkRef): boolean {
  return (
    a.pattern === b.pattern &&
    a.arrowStart === b.arrowStart &&
    a.arrowEnd === b.arrowEnd &&
    a.label === b.label &&
    a.id === b.id &&
    a.length === b.length
  );
}

/**
 * Expands `A & B --> C --> D` into one two-node chain per edge, keeping
 * every node declaration on its first occurrence.
 */
function expandChain(chain: Chain): Chain[] {
  const out: Chain[] = [];
  const declared = new Set<string>();
  const refFor = (r: NodeRef): NodeRef => {
    if (declared.has(r.id)) return { id: r.id, classes: [] };
    declared.add(r.id);
    return { ...r, classes: [...r.classes] };
  };
  chain.links.forEach((link, i) => {
    for (const from of chain.groups[i]!) {
      for (const to of chain.groups[i + 1]!) {
        out.push({ groups: [[refFor(from)], [refFor(to)]], links: [{ ...link }] });
      }
    }
  });
  if (!chain.links.length) {
    for (const ref of chain.groups[0]!) out.push({ groups: [[refFor(ref)]], links: [] });
  }
  return out;
}

function removeLinkFromChain(
  statements: FlowStatement[],
  stmt: ChainStmt,
  linkIndex: number,
  source: string,
  target: string,
  indent: string,
): void {
  const isolated = isolateEdge(statements, stmt, linkIndex, source, target, indent);
  const idx = statements.indexOf(isolated);
  if (idx === -1) return;
  const [from, to] = [isolated.chain.groups[0]![0]!, isolated.chain.groups[1]![0]!];
  const keep: ChainStmt[] = [];
  // Keep declarations (or bare mentions of otherwise-unmentioned nodes) that would be lost.
  for (const ref of [from, to]) {
    const declares =
      ref.label !== undefined ||
      ref.shape ||
      ref.classes.length ||
      (ref.data && Object.keys(ref.data).length);
    const mentionedElsewhere = statements.some(
      (s) =>
        s !== isolated &&
        s.kind === "chain" &&
        s.chain.groups.some((g) => g.some((r) => r.id === ref.id)),
    );
    if (declares || !mentionedElsewhere) {
      keep.push({
        kind: "chain",
        raw: "",
        indent: isolated.indent || indent,
        chain: { groups: [[ref]], links: [] },
        dirty: true,
      });
    }
  }
  statements.splice(idx, 1, ...keep);
}

/** Removes single bare-id statements for nodes that are mentioned elsewhere. */
function dropRedundantBareMentions(statements: FlowStatement[]): void {
  const mentions = new Map<string, number>();
  for (const s of statements) {
    if (s.kind !== "chain") continue;
    for (const g of s.chain.groups)
      for (const r of g) mentions.set(r.id, (mentions.get(r.id) ?? 0) + 1);
  }
  filterInPlace(statements, (s) => {
    if (s.kind !== "chain" || !s.dirty || s.chain.links.length || s.chain.groups[0]!.length !== 1)
      return true;
    const ref = s.chain.groups[0]![0]!;
    const bare =
      ref.label === undefined &&
      !ref.shape &&
      !ref.classes.length &&
      !(ref.data && Object.keys(ref.data).length);
    if (!bare) return true;
    if ((mentions.get(ref.id) ?? 0) > 1) {
      mentions.set(ref.id, mentions.get(ref.id)! - 1);
      return false;
    }
    return true;
  });
}

function removeNodesFromStatements(statements: FlowStatement[], ids: Set<string>): void {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    if (s.kind !== "chain") continue;
    const mentions = s.chain.groups.some((g) => g.some((r) => ids.has(r.id)));
    if (!mentions) continue;
    const pieces = splitChainWithout(s.chain, ids);
    const replacement: ChainStmt[] = pieces.map((chain) => ({
      kind: "chain",
      raw: "",
      indent: s.indent,
      chain,
      dirty: true,
    }));
    statements.splice(i, 1, ...replacement);
    i += replacement.length - 1;
  }
}

/** Removes nodes from a chain, splitting it where a group becomes empty. */
function splitChainWithout(chain: Chain, ids: Set<string>): Chain[] {
  const out: Chain[] = [];
  let cur: Chain = { groups: [], links: [] };
  for (let i = 0; i < chain.groups.length; i++) {
    const group = chain.groups[i]!.filter((r) => !ids.has(r.id));
    if (!group.length) {
      if (cur.groups.length) out.push(cur);
      cur = { groups: [], links: [] };
      continue;
    }
    if (cur.groups.length) cur.links.push({ ...chain.links[i - 1]! });
    cur.groups.push(group);
  }
  if (cur.groups.length) out.push(cur);
  return out;
}

/**
 * Removes several edges. Edges are located by their ordinal in the parsed
 * graph, and removing one rewrites (and may split) chain statements, so the
 * ordinals of the others are only valid against the document they came from.
 * Removing them one at a time, last first, means each removal leaves the
 * edges still to remove untouched; each is re-found in the updated document
 * by its endpoints and its index among edges between the same pair.
 */
function removeEdgesOneByOne(doc: Doc, ids: string[]): Doc {
  const wanted = new Set(ids);
  const targets = doc.graph.edges
    .map((edge, ordinal) => ({ edge, ordinal }))
    .filter(({ edge }) => wanted.has(edge.id))
    .map(({ edge, ordinal }) => ({
      ordinal,
      source: edge.source,
      target: edge.target,
      pairIndex: doc.graph.edges
        .slice(0, ordinal)
        .filter((e) => e.source === edge.source && e.target === edge.target).length,
    }))
    .sort((a, b) => b.ordinal - a.ordinal);
  let current = doc;
  for (const t of targets) {
    const match = current.graph.edges.filter((e) => e.source === t.source && e.target === t.target)[
      t.pairIndex
    ];
    if (match) current = applyFlowchartEdit(current, { type: "removeEdges", ids: [match.id] });
  }
  return current;
}

/** Node data as `@{ … }` raw values: strings quoted, numbers and booleans bare. */
function encodeData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Image-node keys Mermaid reads (`img` makes a node an image whatever its shape). */
const IMAGE_KEYS = ["img", "pos", "w", "h", "constraint"];

/**
 * Keeps a node's data consistent with its shape: an image node always has
 * `img` (empty until one is chosen) so it stays an image; any other shape
 * drops the image keys, which would otherwise turn it back into one.
 */
function shapeDataFor(shape: string, data: Record<string, string>): Record<string, string> {
  const out = { ...data };
  if (shape === "image") {
    if (!("img" in out)) out.img = '""';
  } else {
    for (const key of IMAGE_KEYS) delete out[key];
  }
  return out;
}
