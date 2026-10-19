import type { DiagramGraph, GraphEdge, GraphGroup, GraphNode, Point } from "../types.js";
import { registerFamilyLayout, type Size } from "../layout-registry.js";
import { GIT_METRICS, gitGraphGeometry } from "./geometry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  renameMetaKey,
  uniqueId,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `gitGraph` adapter.
 *
 * ```
 * gitGraph LR:
 *   commit id: "init"
 *   branch develop
 *   checkout develop
 *   commit id: "feat" tag: "v0.1"
 *   checkout main
 *   merge develop
 * ```
 *
 * Canvas model: the statements are simulated in order like Mermaid does
 * (`branch` also checks the new branch out, the starting branch is `main`).
 * Every `commit`, `merge` and `cherry-pick` is a node (shape `commit`, or
 * `merge-commit` for merges); edges are parent links (parent → child, two
 * parents for merges, and a dotted second link from the picked commit for
 * cherry-picks, as Mermaid records it); every branch is a group whose members are its commits.
 * Node ids are the explicit `id:` values, or `c<n>` (the commit's 1-based
 * ordinal in the document) for commits without one — Mermaid generates random
 * ids for those, so they are only stable until an earlier commit is inserted.
 *
 * Edits never produce text Mermaid rejects: after removals, merges and
 * cherry-picks that became invalid (same head, missing source…) are dropped,
 * and `addEdge` only appends a `merge` when it is valid at the end of the
 * document.
 *
 * @module
 */

interface Attr {
  key: string;
  value: string;
  quoted: boolean;
}

export type GitStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & {
      kind: "commit";
      attrs: Attr[];
      /** Attributes the diagram module could not read; the line is never regenerated. */
      opaque: boolean;
    })
  | (BaseStatement & { kind: "merge"; branch: string; attrs: Attr[]; opaque: boolean })
  | (BaseStatement & { kind: "cherryPick"; attrs: Attr[]; opaque: boolean })
  | (BaseStatement & { kind: "branch"; name: string; order?: string })
  | (BaseStatement & { kind: "checkout"; keyword: "checkout" | "switch"; name: string });

type Of<K extends GitStatement["kind"]> = Extract<GitStatement, { kind: K }>;
type CommitLike = Of<"commit"> | Of<"merge"> | Of<"cherryPick">;

const MAIN = "main";
const COMMIT_TYPES = ["NORMAL", "REVERSE", "HIGHLIGHT"] as const;
const NAME = String.raw`("[^"]*"|[^\s"]+)`;
const ATTR = /\s*([\w-]+)\s*:\s*("[^"]*"|[^\s"]+)/y;
const HEADER = /^(\s*gitGraph)\s*(?:(LR|TB|BT|TD)?\s*:)?\s*$/i;

function parseAttrs(text: string): { attrs: Attr[]; opaque: boolean } {
  const attrs: Attr[] = [];
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = ATTR.exec(text))) {
    const quoted = m[2]!.startsWith('"');
    attrs.push({ key: m[1]!, value: quoted ? m[2]!.slice(1, -1) : m[2]!, quoted });
    end = ATTR.lastIndex;
  }
  return { attrs, opaque: text.slice(end).trim() !== "" };
}

const unq = (name: string) => (name.startsWith('"') ? name.slice(1, -1) : name);
const fmtName = (name: string) => (/[\s"]/.test(name) ? `"${name.replace(/"/g, "'")}"` : name);
const fmtAttrs = (attrs: Attr[]) =>
  attrs.map((a) => ` ${a.key}: ${a.quoted ? `"${a.value}"` : a.value}`).join("");
/** Mermaid strings cannot escape `"`, so values swap them for `'`. */
const cleanValue = (v: string) =>
  v
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, " ")
    .trim();

function attr(s: CommitLike, key: string): string | undefined {
  return s.attrs.find((a) => a.key === key)?.value;
}

/** Sets (or, with `undefined`, removes) an attribute; returns false for opaque lines. */
function setAttr(s: CommitLike, key: string, value: string | undefined): boolean {
  if (s.opaque) return false;
  const first = s.attrs.findIndex((a) => a.key === key);
  filterInPlace(s.attrs, (a, i) => a.key !== key || (i === first && value !== undefined));
  if (value !== undefined) {
    const entry = { key, value, quoted: key !== "type" };
    if (first !== -1) s.attrs[first] = entry;
    else if (key === "id") s.attrs.unshift(entry);
    else s.attrs.push(entry);
  }
  s.dirty = true;
  return true;
}

function headerDirection(header: string): string {
  const d = HEADER.exec(header)?.[2]?.toUpperCase();
  return !d ? "LR" : d === "TD" ? "TB" : d;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface CommitInfo {
  stmt: CommitLike;
  id: string;
  explicitId: boolean;
  label: string;
  branch: string;
  kind: "commit" | "merge" | "cherry-pick";
  parents: string[];
  ordinal: number;
}

interface BranchInfo {
  name: string;
  tip?: string;
  stmt?: Of<"branch">;
}

interface Simulation {
  commits: CommitInfo[];
  byId: Map<string, CommitInfo>;
  branches: Map<string, BranchInfo>;
  /** Checked-out branch after the last statement. */
  current: string;
  /** First merge / cherry-pick Mermaid would reject, if any. */
  invalid?: GitStatement;
}

function simulate(statements: GitStatement[]): Simulation {
  const explicit = new Set<string>();
  for (const s of statements)
    if ((s.kind === "commit" || s.kind === "merge") && attr(s, "id") !== undefined)
      explicit.add(attr(s, "id")!);
  const taken = new Set(explicit);
  const assigned = new Set<string>();
  const commits: CommitInfo[] = [];
  const byId = new Map<string, CommitInfo>();
  /** Ids Mermaid itself knows (explicit ones). */
  const realIds = new Map<string, CommitInfo>();
  const branches = new Map<string, BranchInfo>([[MAIN, { name: MAIN }]]);
  let current = MAIN;
  let invalid: GitStatement | undefined;
  let ordinal = 0;

  const tipOf = (b: string) => {
    const tip = branches.get(b)?.tip;
    return tip === undefined ? undefined : byId.get(tip);
  };
  const add = (stmt: CommitLike, kind: CommitInfo["kind"], parents: string[]) => {
    ordinal++;
    const own = stmt.kind === "cherryPick" ? undefined : attr(stmt, "id");
    let id: string;
    if (own !== undefined && !assigned.has(own)) id = own;
    else id = uniqueId(own ?? `c${ordinal}`, taken);
    assigned.add(id);
    taken.add(id);
    const msg = stmt.kind === "commit" ? attr(stmt, "msg") : undefined;
    const info: CommitInfo = {
      stmt,
      id,
      explicitId: own !== undefined,
      label: own ?? (msg || id),
      branch: current,
      kind,
      parents,
      ordinal,
    };
    commits.push(info);
    byId.set(id, info);
    if (own !== undefined) realIds.set(own, info);
    if (!branches.has(current)) branches.set(current, { name: current });
    branches.get(current)!.tip = id;
  };

  for (const s of statements) {
    switch (s.kind) {
      case "commit": {
        const tip = tipOf(current);
        add(s, "commit", tip ? [tip.id] : []);
        break;
      }
      case "branch":
        if (!branches.has(s.name)) branches.set(s.name, { name: s.name, stmt: s });
        branches.get(s.name)!.tip = branches.get(current)?.tip;
        current = s.name;
        break;
      case "checkout":
        current = s.name;
        break;
      case "merge": {
        const cur = tipOf(current);
        const other = tipOf(s.branch);
        const customId = attr(s, "id");
        const bad =
          current === s.branch ||
          !branches.has(s.branch) ||
          !cur ||
          !other ||
          cur === other ||
          cur.branch === s.branch ||
          (customId !== undefined && realIds.has(customId));
        if (bad) invalid ??= s;
        add(
          s,
          "merge",
          [cur?.id, other?.id].filter((p): p is string => !!p),
        );
        break;
      }
      case "cherryPick": {
        const source = realIds.get(attr(s, "id") ?? "");
        const parent = attr(s, "parent");
        const cur = tipOf(current);
        const bad =
          !source ||
          (parent !== undefined && !source.parents.includes(parent)) ||
          (source.kind === "merge" && parent === undefined) ||
          source.branch === current ||
          !cur;
        if (bad) invalid ??= s;
        // Like Mermaid: the current tip, then the picked commit as a second parent.
        add(
          s,
          "cherry-pick",
          [cur?.id, source?.id].filter((p): p is string => !!p),
        );
        break;
      }
      default:
        break;
    }
  }
  return { commits, byId, branches, current, invalid };
}

/** Drops merges / cherry-picks Mermaid would reject, one at a time until none is left. */
function repair(statements: GitStatement[]): void {
  for (let guard = statements.length; guard > 0; guard--) {
    const bad = simulate(statements).invalid;
    if (!bad) return;
    statements.splice(statements.indexOf(bad), 1);
  }
}

function edgeList(sim: Simulation): GraphEdge[] {
  const counts = new Map<string, number>();
  const edges: GraphEdge[] = [];
  for (const c of sim.commits) {
    c.parents.forEach((p, i) => {
      const key = `${p}\u0000${c.id}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const second = i === 1;
      edges.push({
        id: `L_${p}_${c.id}_${n}`,
        source: p,
        target: c.id,
        pattern: second && c.kind === "cherry-pick" ? "dotted" : "solid",
        arrowStart: "none",
        arrowEnd: "arrow_point",
        length: 1,
        classes: [],
        styles: [],
        userDefinedId: false,
        data: {
          merge: second && c.kind === "merge",
          ...(second && c.kind === "cherry-pick" ? { cherryPick: true } : {}),
        },
      });
    });
  }
  return edges;
}

function branchName(label: string): string {
  return (
    label
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\w\-./]/g, "") || "branch"
  );
}

export const gitGraphGrammar: StatementGrammar<GitStatement> = {
  family: "gitGraph",

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^commit\b(.*)$/.exec(text)))
      return { kind: "commit", raw: line, indent, ...parseAttrs(m[1]!) };
    if ((m = new RegExp(`^merge\\s+${NAME}(.*)$`).exec(text)))
      return { kind: "merge", raw: line, indent, branch: unq(m[1]!), ...parseAttrs(m[2]!) };
    if ((m = /^cherry-pick\b(.*)$/.exec(text)))
      return { kind: "cherryPick", raw: line, indent, ...parseAttrs(m[1]!) };
    if ((m = new RegExp(`^branch\\s+${NAME}(?:\\s+order\\s*:\\s*(\\d+))?\\s*$`).exec(text)))
      return { kind: "branch", raw: line, indent, name: unq(m[1]!), order: m[2] };
    if ((m = new RegExp(`^(checkout|switch)\\s+${NAME}\\s*$`).exec(text)))
      return {
        kind: "checkout",
        raw: line,
        indent,
        keyword: m[1] as "checkout" | "switch",
        name: unq(m[2]!),
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    const i = stmt.indent;
    switch (stmt.kind) {
      case "commit":
        return stmt.opaque ? stmt.raw : `${i}commit${fmtAttrs(stmt.attrs)}`;
      case "merge":
        return stmt.opaque ? stmt.raw : `${i}merge ${fmtName(stmt.branch)}${fmtAttrs(stmt.attrs)}`;
      case "cherryPick":
        return stmt.opaque ? stmt.raw : `${i}cherry-pick${fmtAttrs(stmt.attrs)}`;
      case "branch":
        return `${i}branch ${fmtName(stmt.name)}${stmt.order ? ` order: ${stmt.order}` : ""}`;
      case "checkout":
        return `${i}${stmt.keyword} ${fmtName(stmt.name)}`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const sim = simulate(statements);
    const nodes: GraphNode[] = sim.commits.map((c) => {
      const tag = attr(c.stmt, "tag");
      const msg = c.stmt.kind === "commit" ? attr(c.stmt, "msg") : undefined;
      const from = c.stmt.kind === "cherryPick" ? attr(c.stmt, "id") : undefined;
      return {
        id: c.id,
        label: c.label,
        shape: c.kind === "merge" ? "merge-commit" : "commit",
        parentId: c.branch,
        classes: [],
        styles: [],
        data: {
          branch: c.branch,
          tag,
          type: attr(c.stmt, "type") ?? "NORMAL",
          msg,
          kind: c.kind,
          explicitId: c.explicitId,
          ...(from !== undefined ? { from } : {}),
          details: [c.branch, tag ? `tag: ${tag}` : undefined].filter(Boolean),
        },
      };
    });
    const groups: GraphGroup[] = [...sim.branches.values()].map((b) => ({
      id: b.name,
      label: b.name,
      classes: [],
      styles: [],
      data: b.stmt?.order !== undefined ? { order: Number(b.stmt.order) } : {},
    }));
    const graph: DiagramGraph = {
      direction: headerDirection(ctx.header),
      nodes,
      edges: edgeList(sim),
      groups,
      classDefs: {},
      title: ctx.frontmatterTitle,
    };
    return { graph };
  },

  /** Positions come from the commit order (see `./geometry`): drags and layout pins are not stored. */
  interceptMeta(op) {
    return op.type === "moveNodes";
  },

  edit(op, ctx) {
    return editGit(op, ctx);
  },
};

function editGit(
  op: Parameters<StatementGrammar<GitStatement>["edit"]>[0],
  ctx: EditContext<GitStatement>,
): boolean {
  const { statements, indent } = ctx;
  const sim = simulate(statements);
  const checkoutIfNeeded = (branch: string) => {
    if (sim.current !== branch)
      statements.push({
        kind: "checkout",
        raw: "",
        indent,
        keyword: "checkout",
        name: branch,
        dirty: true,
      });
  };

  switch (op.type) {
    case "addNode": {
      const parent = op.node.parentId;
      const branch =
        parent && sim.branches.has(parent)
          ? parent
          : parent && sim.byId.has(parent)
            ? sim.byId.get(parent)!.branch
            : sim.current;
      if (!sim.branches.has(branch)) return false;
      const label = cleanValue(op.node.label ?? "") || "New commit";
      const id = uniqueId(label, new Set(sim.byId.keys()));
      checkoutIfNeeded(branch);
      const stmt: Of<"commit"> = {
        kind: "commit",
        raw: "",
        indent,
        attrs: [{ key: "id", value: id, quoted: true }],
        opaque: false,
        dirty: true,
      };
      applyData(stmt, op.node.data ?? {});
      statements.push(stmt);
      return true;
    }
    case "renameNode": {
      const c = sim.byId.get(op.id);
      if (!c || c.stmt.kind === "cherryPick" || c.stmt.opaque) return false;
      const label = cleanValue(op.label);
      if (!label) return false;
      const others = new Set([...sim.byId.keys()].filter((k) => k !== op.id));
      const id = uniqueId(label, others);
      setAttr(c.stmt, "id", id);
      if (c.explicitId) {
        for (const s of statements) {
          if (s.kind !== "cherryPick" || s.opaque) continue;
          for (const a of s.attrs) {
            if ((a.key === "id" || a.key === "parent") && a.value === op.id) {
              a.value = id;
              s.dirty = true;
            }
          }
        }
      }
      renameMetaKey(ctx.meta, op.id, id);
      return true;
    }
    case "setNodeData": {
      const c = sim.byId.get(op.id);
      if (!c) return false;
      return applyData(c.stmt, op.data);
    }
    case "removeNodes": {
      const remove = new Set(op.ids.map((id) => sim.byId.get(id)?.stmt).filter(Boolean));
      if (!remove.size) return false;
      filterInPlace(statements, (s) => !remove.has(s as CommitLike));
      repair(statements);
      dropMetaKeys(ctx.meta, op.ids);
      return true;
    }
    case "addEdge": {
      const a = sim.byId.get(op.edge.source);
      const b = sim.byId.get(op.edge.target);
      if (!a || !b || a.branch === b.branch) return false;
      if (sim.branches.get(a.branch)?.tip !== a.id || sim.branches.get(b.branch)?.tip !== b.id)
        return false;
      const before = statements.length;
      checkoutIfNeeded(b.branch);
      statements.push({
        kind: "merge",
        raw: "",
        indent,
        branch: a.branch,
        attrs: [],
        opaque: false,
        dirty: true,
      });
      if (simulate(statements).invalid) {
        statements.length = before;
        return false;
      }
      return true;
    }
    case "removeEdges": {
      const edges = edgeList(sim);
      const remove = new Set<GitStatement>();
      for (const id of op.ids) {
        const e = edges.find((x) => x.id === id);
        if (e?.data?.merge || e?.data?.cherryPick) remove.add(sim.byId.get(e.target)!.stmt);
      }
      if (!remove.size) return false;
      filterInPlace(statements, (s) => !remove.has(s));
      repair(statements);
      return true;
    }
    case "groupNodes": {
      const name = uniqueId(branchName(op.label), new Set(sim.branches.keys()));
      statements.push(
        { kind: "branch", raw: "", indent, name, dirty: true },
        { kind: "checkout", raw: "", indent, keyword: "checkout", name, dirty: true },
      );
      return true;
    }
    case "renameGroup": {
      const info = sim.branches.get(op.id);
      if (!info?.stmt) return false; // `main` (or a branch never created) cannot be renamed
      const others = new Set([...sim.branches.keys()].filter((k) => k !== op.id));
      const name = uniqueId(branchName(op.label), others);
      for (const s of statements) {
        if ((s.kind === "branch" || s.kind === "checkout") && s.name === op.id) {
          s.name = name;
          s.dirty = true;
        } else if (s.kind === "merge" && s.branch === op.id && !s.opaque) {
          s.branch = name;
          s.dirty = true;
        }
      }
      renameMetaKey(ctx.meta, op.id, name);
      return true;
    }
    case "setDirection": {
      const m = HEADER.exec(ctx.doc.header);
      const d = op.direction.toUpperCase() === "TD" ? "TB" : op.direction.toUpperCase();
      if (!m || !["LR", "TB", "BT"].includes(d)) return false;
      ctx.setHeader(`${m[1]} ${d}:`);
      return true;
    }
    default:
      return false;
  }
}

/** Applies `tag` / `type` / `msg` from a data payload; returns true when anything changed. */
function applyData(stmt: CommitLike, data: Record<string, unknown>): boolean {
  let changed = false;
  if (typeof data.tag === "string")
    changed = setAttr(stmt, "tag", cleanValue(data.tag) || undefined) || changed;
  if (typeof data.type === "string" && stmt.kind !== "cherryPick") {
    const t = data.type.toUpperCase();
    if (t === "" || (COMMIT_TYPES as readonly string[]).includes(t))
      changed = setAttr(stmt, "type", t === "" || t === "NORMAL" ? undefined : t) || changed;
  }
  if (typeof data.msg === "string" && stmt.kind === "commit")
    changed = setAttr(stmt, "msg", cleanValue(data.msg) || undefined) || changed;
  return changed;
}

export const gitGraphAdapter = createStatementAdapter(gitGraphGrammar);

/**
 * Positions are Mermaid's own (see `./geometry`): branches are lanes in
 * `order`, commits advance 50px per commit in document order. Each commit is a
 * small box centred on its bullet; each branch is its name pill at the lane's
 * start. Stored positions are ignored, since Mermaid derives them.
 */
registerFamilyLayout("gitGraph", (graph) => {
  const geo = gitGraphGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  const box = GIT_METRICS.commitBox;
  for (const c of geo.commits.values()) {
    positions[c.id] = [c.x - box / 2, c.y - box / 2];
    sizes[c.id] = { width: box, height: box };
  }
  for (const lane of geo.lanes) {
    positions[lane.branch] = [lane.label.x, lane.label.y];
    sizes[lane.branch] = { width: lane.label.width, height: lane.label.height };
  }
  return { positions, sizes };
});
