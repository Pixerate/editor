import type {
  ArrowHead,
  DiagramGraph,
  EditOp,
  EdgePattern,
  GraphEdge,
  GraphGroup,
  GraphNode,
  Point,
} from "../types.js";
import { registerFamilyLayout, type Size } from "../layout-registry.js";
import { SEQUENCE_METRICS, dropIndex, sequenceGeometry, type SequenceEvent } from "./geometry.js";
import { setFrontmatterTitle } from "../lines-grammar/engine.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  renameMetaKey,
  slugId,
  uniqueId,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `sequenceDiagram` adapter.
 *
 * ```
 * sequenceDiagram
 *   autonumber
 *   actor U as Customer
 *   participant W as Web app
 *   U->>W: Place order
 *   alt Approved
 *     W-->>U: Order confirmed
 *   end
 * ```
 *
 * Canvas model: one node per participant (shape `rect`, or `actor` for
 * `actor` declarations), declared ones first in declaration order, then the
 * ones only mentioned in messages. One edge per message line in document
 * order; `data.index` is the message's position, `data.kind` the arrow token,
 * `data.activate` / `data.deactivate` the `+` / `-` suffixes. `box … end`
 * blocks are groups (`data.color` keeps the box colour). Fragments (`alt`,
 * `loop`, `par`…), notes, activations and every other line are kept verbatim;
 * messages inside fragments are still edges. `graph.data.autonumber` mirrors
 * the `autonumber` statement.
 *
 * Message edge ids are `L_<from>_<to>_<n>` where `n` counts messages of the
 * same pair in document order, so unrelated edits keep them stable.
 *
 * @module
 */

type ParticipantKeyword = "participant" | "actor";
type Modifier = "" | "+" | "-";

export type SequenceStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string; colon: boolean })
  | (BaseStatement & { kind: "autonumber"; off: boolean })
  | (BaseStatement & {
      kind: "participant";
      keyword: ParticipantKeyword;
      id: string;
      alias?: string;
      /** `@{ … }` participant configuration, kept verbatim. */
      config?: string;
      create: boolean;
    })
  | (BaseStatement & {
      kind: "message";
      from: string;
      to: string;
      arrow: string;
      mod: Modifier;
      text: string;
    })
  | (BaseStatement & { kind: "box"; color?: string; label: string })
  /** Fragment openers (`alt`, `loop`…) and continuations (`else`, `and`, `option`). */
  | (BaseStatement & { kind: "block"; keyword: string; text: string; opens: boolean })
  | (BaseStatement & { kind: "end" })
  /** Lines that reference participants (`Note`, `activate`, `destroy`, `link`…). */
  | (BaseStatement & { kind: "ref"; keyword: string; targets: string[] });

type Of<K extends SequenceStatement["kind"]> = Extract<SequenceStatement, { kind: K }>;
type Participant = Of<"participant">;
type Message = Of<"message">;
type Box = Of<"box">;

interface ArrowSpec {
  token: string;
  pattern: EdgePattern;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
}

/** Arrow tokens, longest first so the regex alternation picks the right one. */
const ARROWS: ArrowSpec[] = [
  { token: "<<-->>", pattern: "dotted", arrowStart: "arrow_point", arrowEnd: "arrow_point" },
  { token: "<<->>", pattern: "solid", arrowStart: "arrow_point", arrowEnd: "arrow_point" },
  { token: "-->>", pattern: "dotted", arrowStart: "none", arrowEnd: "arrow_point" },
  { token: "->>", pattern: "solid", arrowStart: "none", arrowEnd: "arrow_point" },
  { token: "--x", pattern: "dotted", arrowStart: "none", arrowEnd: "arrow_cross" },
  { token: "-x", pattern: "solid", arrowStart: "none", arrowEnd: "arrow_cross" },
  { token: "--)", pattern: "dotted", arrowStart: "none", arrowEnd: "arrow_open" },
  { token: "-)", pattern: "solid", arrowStart: "none", arrowEnd: "arrow_open" },
  { token: "-->", pattern: "dotted", arrowStart: "none", arrowEnd: "none" },
  { token: "->", pattern: "solid", arrowStart: "none", arrowEnd: "none" },
];
const ARROW_BY_TOKEN = new Map(ARROWS.map((a) => [a.token, a]));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MESSAGE = new RegExp(
  `^([^:]+?)\\s*(${ARROWS.map((a) => escapeRe(a.token)).join("|")})\\s*([+-]?)\\s*([^:]+?)\\s*:(.*)$`,
);
const PARTICIPANT = /^(create\s+)?(participant|actor)\s+(.+?)(\s*@\{.*\})?(?:\s+as\s+(.*?))?\s*$/;
const BLOCK_OPEN = /^(alt|opt|loop|par_over|par|critical|break|rect)\b\s*(.*)$/;
const BLOCK_CONT = /^(else|and|option)\b\s*(.*)$/;
const NOTE = /^note\s+(?:left\s+of|right\s+of|over)\s+([^:]+?)\s*:/i;
const TARGET_LINE = /^(activate|deactivate|destroy)\s+(.+?)\s*$/;
const LINK_LINE = /^(links|link|properties|details)\s+([^:]+?)\s*:/;

/** CSS named colours Mermaid accepts as the first word of a `box` line. */
const CSS_COLORS = new Set(
  (
    "transparent aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond " +
    "blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** Splits a `box` line's text into colour and label the way Mermaid does. */
function parseBoxText(text: string): { color?: string; label: string } {
  const fn = /^((?:rgba?|hsla?)\s*\([^)]*\))\s*(.*)$/i.exec(text);
  if (fn) return { color: fn[1]!, label: fn[2]!.trim() };
  const word = /^(\w+)\s*(.*)$/.exec(text);
  if (word && CSS_COLORS.has(word[1]!.toLowerCase())) return { color: word[1]!, label: word[2]! };
  return { label: text.trim() };
}

/** True when Mermaid would read the label's first word as a colour. */
function labelLooksLikeColor(label: string): boolean {
  return parseBoxText(label).color !== undefined;
}

function splitTargets(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Mermaid strips a leading `+`/`-` from activation targets too. */
function parseRef(text: string): { keyword: string; targets: string[] } | null {
  let m: RegExpExecArray | null;
  if ((m = NOTE.exec(text))) return { keyword: "note", targets: splitTargets(m[1]!) };
  if ((m = TARGET_LINE.exec(text))) return { keyword: m[1]!, targets: [m[2]!.trim()] };
  if ((m = LINK_LINE.exec(text))) return { keyword: m[1]!, targets: [m[2]!.trim()] };
  return null;
}

// ---------------------------------------------------------------------------
// Analysis shared by buildGraph and edit
// ---------------------------------------------------------------------------

interface BoxInfo {
  stmt: Box;
  index: number;
  endIndex: number;
  /** The closing `end` statement (undefined when the box is unterminated). */
  end?: SequenceStatement;
  id: string;
}

interface ParticipantInfo {
  id: string;
  /** First declaration (create declarations included). */
  decl?: Participant;
  box?: BoxInfo;
}

interface MessageInfo {
  stmt: Message;
  index: number;
  edgeId: string;
  /** Enclosing fragment text (`alt Approved`, `else Declined`…). */
  block?: string;
}

interface Analysis {
  participants: Map<string, ParticipantInfo>;
  messages: MessageInfo[];
  boxes: BoxInfo[];
  /** Box containing each statement index. */
  boxAt: Map<number, BoxInfo>;
}

function analyse(statements: SequenceStatement[]): Analysis {
  const participants = new Map<string, ParticipantInfo>();
  const messages: MessageInfo[] = [];
  const boxes: BoxInfo[] = [];
  const boxAt = new Map<number, BoxInfo>();
  const stack: { box?: BoxInfo; text?: string }[] = [];
  const pairCount = new Map<string, number>();
  const mentioned: string[] = [];

  statements.forEach((s, i) => {
    const top = stack[stack.length - 1];
    if (top?.box) boxAt.set(i, top.box);
    switch (s.kind) {
      case "box": {
        const info: BoxInfo = { stmt: s, index: i, endIndex: statements.length, id: "" };
        boxes.push(info);
        stack.push({ box: info });
        break;
      }
      case "block":
        if (s.opens) stack.push({ text: s.raw.trim() });
        else if (top && !top.box) top.text = s.raw.trim();
        break;
      case "end": {
        const popped = stack.pop();
        if (popped?.box) {
          popped.box.endIndex = i;
          popped.box.end = s;
        }
        break;
      }
      case "participant":
        if (!participants.has(s.id)) participants.set(s.id, { id: s.id, decl: s, box: top?.box });
        break;
      case "message": {
        const key = `${s.from}\u0000${s.to}`;
        const n = pairCount.get(key) ?? 0;
        pairCount.set(key, n + 1);
        const block = [...stack].reverse().find((f) => f.text)?.text;
        messages.push({ stmt: s, index: i, edgeId: `L_${s.from}_${s.to}_${n}`, block });
        mentioned.push(s.from, s.to);
        break;
      }
      default:
        break;
    }
  });
  for (const id of mentioned) if (!participants.has(id)) participants.set(id, { id });
  const taken = new Set(participants.keys());
  for (const b of boxes) b.id = uniqueId(slugId(b.stmt.label, "box"), taken);
  return { participants, messages, boxes, boxAt };
}

function arrowFor(pattern: EdgePattern, arrowStart: ArrowHead, arrowEnd: ArrowHead): string {
  const dotted = pattern === "dotted";
  if (arrowStart === "arrow_point" && arrowEnd === "arrow_point")
    return dotted ? "<<-->>" : "<<->>";
  switch (arrowEnd) {
    case "none":
      return dotted ? "-->" : "->";
    case "arrow_cross":
      return dotted ? "--x" : "-x";
    case "arrow_open":
      return dotted ? "--)" : "-)";
    default:
      return dotted ? "-->>" : "->>";
  }
}

/** Index after the last top-level (non-`create`) declaration or box, else after title/autonumber. */
function declarationInsertIndex(statements: SequenceStatement[], a: Analysis): number {
  let last = -1;
  statements.forEach((s, i) => {
    if (s.kind === "participant" && !s.create && !a.boxAt.has(i)) last = i;
  });
  for (const b of a.boxes) last = Math.max(last, b.endIndex);
  if (last !== -1) return Math.min(last + 1, statements.length);
  let j = 0;
  while (j < statements.length && /^(title|autonumber)$/.test(statements[j]!.kind)) j++;
  return j;
}

function newDecl(
  indent: string,
  id: string,
  keyword: ParticipantKeyword,
  alias?: string,
): Participant {
  return {
    kind: "participant",
    raw: "",
    indent,
    keyword,
    id,
    alias: alias && alias !== id ? alias : undefined,
    create: false,
    dirty: true,
  };
}

/**
 * Keeps Mermaid's lifecycle rules satisfied after structural edits: a
 * `create` declaration must be followed by a message to it, a `destroy` by a
 * message involving it, and deactivations need an active participant.
 * Offending `create` flags / `-` suffixes are dropped and orphan `destroy`,
 * `deactivate` lines removed, so edits never produce text Mermaid rejects.
 */
function repairLifecycle(statements: SequenceStatement[]): void {
  const seen = new Set<string>();
  const active = new Map<string, number>();
  const drop = new Set<SequenceStatement>();
  let pendingCreate: Participant | undefined;
  let pendingDestroy: { stmt: SequenceStatement; id: string } | undefined;
  const clearCreate = (p: Participant) => {
    p.create = false;
    p.dirty = true;
  };
  for (const s of statements) {
    if (s.kind === "participant") {
      if (s.create) {
        if (pendingCreate) clearCreate(pendingCreate);
        if (seen.has(s.id)) clearCreate(s);
        else pendingCreate = s;
      }
      seen.add(s.id);
    } else if (s.kind === "message") {
      if (pendingCreate) {
        if (s.to !== pendingCreate.id) clearCreate(pendingCreate);
        pendingCreate = undefined;
      } else if (pendingDestroy) {
        if (s.to !== pendingDestroy.id && s.from !== pendingDestroy.id)
          drop.add(pendingDestroy.stmt);
        pendingDestroy = undefined;
      }
      seen.add(s.from);
      seen.add(s.to);
      if (s.mod === "+") active.set(s.to, (active.get(s.to) ?? 0) + 1);
      if (s.mod === "-") {
        const n = active.get(s.from) ?? 0;
        if (n < 1) {
          s.mod = "";
          s.dirty = true;
        } else active.set(s.from, n - 1);
      }
    } else if (s.kind === "ref") {
      const id = s.targets[0]?.replace(/^[+-]/, "") ?? "";
      if (s.keyword === "destroy") {
        if (pendingDestroy) drop.add(pendingDestroy.stmt);
        pendingDestroy = { stmt: s, id };
      } else if (s.keyword === "activate") active.set(id, (active.get(id) ?? 0) + 1);
      else if (s.keyword === "deactivate") {
        const n = active.get(id) ?? 0;
        if (n < 1) drop.add(s);
        else active.set(id, n - 1);
      }
    }
  }
  if (pendingCreate) clearCreate(pendingCreate);
  if (pendingDestroy) drop.add(pendingDestroy.stmt);
  if (drop.size) filterInPlace(statements, (s) => !drop.has(s));
}

/** `box` statements that contain no declaration. */
function emptyBoxes(statements: SequenceStatement[]): BoxInfo[] {
  return analyse(statements).boxes.filter(
    (b) =>
      b.end && !statements.slice(b.index + 1, b.endIndex).some((s) => s.kind === "participant"),
  );
}

/** Moves (or creates) declarations for `ids`, returning them detached from the list. */
function takeDeclarations(
  ctx: EditContext<SequenceStatement>,
  ids: string[],
  a: Analysis,
): Participant[] {
  const out: Participant[] = [];
  const remove = new Set<SequenceStatement>();
  for (const id of ids) {
    const info = a.participants.get(id);
    if (!info) continue;
    if (info.decl?.create) continue; // created participants stay where their message is
    if (info.decl) {
      remove.add(info.decl);
      out.push(info.decl);
    } else out.push(newDecl(ctx.indent, id, "participant"));
  }
  filterInPlace(ctx.statements, (s) => !remove.has(s));
  return out;
}

function setIndent(stmts: SequenceStatement[], indent: string): void {
  for (const s of stmts) {
    if (s.indent !== indent) {
      s.indent = indent;
      s.dirty = true;
    }
  }
}

const NOTE_TEXT = /^note\s+(left\s+of|right\s+of|over)\s+([^:]+?)\s*:\s*(.*)$/i;

/** Rows Mermaid draws, in document order (see {@link SequenceEvent}). */
function sequenceEvents(statements: SequenceStatement[], a: Analysis): SequenceEvent[] {
  const edgeOf = new Map(a.messages.map((m) => [m.stmt, m.edgeId]));
  const events: SequenceEvent[] = [];
  const stack: ("box" | "frag")[] = [];
  for (const s of statements) {
    switch (s.kind) {
      case "box":
        stack.push("box");
        break;
      case "block":
        if (s.opens) {
          stack.push("frag");
          events.push({ kind: "open", keyword: s.keyword, text: s.text.trim() });
        } else events.push({ kind: "else", keyword: s.keyword, text: s.text.trim() });
        break;
      case "end":
        if (stack.pop() === "frag") events.push({ kind: "end" });
        break;
      case "message":
        events.push({
          kind: "message",
          edgeId: edgeOf.get(s)!,
          from: s.from,
          to: s.to,
          mod: s.mod,
        });
        break;
      case "ref": {
        if (s.keyword === "note") {
          const m = NOTE_TEXT.exec(s.raw.trim());
          if (!m) break;
          const where = m[1]!.toLowerCase();
          events.push({
            kind: "note",
            placement: where.startsWith("left")
              ? "left"
              : where.startsWith("right")
                ? "right"
                : "over",
            targets: splitTargets(m[2]!),
            text: m[3]!.replace(/<br\s*\/?>/gi, " "),
          });
        } else if (s.keyword === "activate" || s.keyword === "deactivate")
          events.push({ kind: s.keyword, target: s.targets[0]! });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

/**
 * Dragging a participant reorders the columns: its declaration moves next to
 * the participant it was dropped beside. Positions are never stored, since
 * Mermaid derives them from the order.
 */
function reorderParticipants(op: EditOp, ctx: EditContext<SequenceStatement>): boolean {
  if (op.type !== "moveNodes") return false;
  const geometry = sequenceGeometry(ctx.doc.graph);
  for (const { id, position } of op.moves) {
    const col = geometry.columns.get(id);
    if (!col) continue; // boxes follow their members
    const from = geometry.order.indexOf(id);
    const to = dropIndex(geometry, id, position[0] + col.width / 2);
    if (to === from) continue;
    const a = analyse(ctx.statements);
    if (a.participants.get(id)?.decl?.create) continue;
    // Declare everyone (in the current order) so the new order can be written.
    const undeclared = geometry.order.filter((p) => !a.participants.get(p)?.decl);
    if (undeclared.length) {
      const at = declarationInsertIndex(ctx.statements, a);
      ctx.statements.splice(at, 0, ...undeclared.map((p) => newDecl(ctx.indent, p, "participant")));
    }
    const fresh = analyse(ctx.statements);
    const others = geometry.order.filter((p) => p !== id);
    const anchorId = to < others.length ? others[to]! : others[others.length - 1]!;
    const anchor = fresh.participants.get(anchorId)?.decl;
    const moved = fresh.participants.get(id)?.decl;
    if (!anchor || !moved || anchor.create) continue;
    ctx.statements.splice(ctx.statements.indexOf(moved), 1);
    if (moved.indent !== anchor.indent) {
      moved.indent = anchor.indent;
      moved.dirty = true;
    }
    const at = ctx.statements.indexOf(anchor);
    ctx.statements.splice(to < others.length ? at : at + 1, 0, moved);
  }
  return true;
}

export const sequenceGrammar: StatementGrammar<SequenceStatement> = {
  family: "sequence",
  titleAsStatement: true,
  interceptMeta: reorderParticipants,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if (!text || text.startsWith("%%")) return { kind: "raw", raw: line, indent };
    if ((m = /^title(\s*:\s*|\s+)(.*)$/.exec(text)))
      return { kind: "title", raw: line, indent, title: m[2]!.trim(), colon: m[1]!.includes(":") };
    if ((m = /^autonumber\b(.*)$/.exec(text)))
      return { kind: "autonumber", raw: line, indent, off: m[1]!.trim() === "off" };
    if ((m = PARTICIPANT.exec(text)))
      return {
        kind: "participant",
        raw: line,
        indent,
        create: !!m[1],
        keyword: m[2] as ParticipantKeyword,
        id: m[3]!.trim(),
        config: m[4]?.trim() || undefined,
        alias: m[5]?.trim() || undefined,
      };
    if ((m = /^box(?:\s+(.*))?$/.exec(text))) {
      const box = parseBoxText(m[1] ?? "");
      return { kind: "box", raw: line, indent, color: box.color, label: box.label };
    }
    if (text === "end") return { kind: "end", raw: line, indent };
    if ((m = BLOCK_OPEN.exec(text)))
      return { kind: "block", raw: line, indent, keyword: m[1]!, text: m[2]!, opens: true };
    if ((m = BLOCK_CONT.exec(text)))
      return { kind: "block", raw: line, indent, keyword: m[1]!, text: m[2]!, opens: false };
    const ref = parseRef(text);
    if (ref) return { kind: "ref", raw: line, indent, ...ref };
    if ((m = MESSAGE.exec(text)))
      return {
        kind: "message",
        raw: line,
        indent,
        from: m[1]!.trim(),
        arrow: m[2]!,
        mod: m[3] as Modifier,
        to: m[4]!.trim(),
        text: m[5]!.trim(),
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    const i = stmt.indent;
    switch (stmt.kind) {
      case "title":
        return `${i}title${stmt.colon ? ": " : " "}${stmt.title}`;
      case "autonumber":
        return `${i}autonumber${stmt.off ? " off" : ""}`;
      case "participant":
        return `${i}${stmt.create ? "create " : ""}${stmt.keyword} ${stmt.id}${
          stmt.config ? stmt.config : ""
        }${stmt.alias ? ` as ${stmt.alias}` : ""}`;
      case "message":
        return `${i}${stmt.from}${stmt.arrow}${stmt.mod}${stmt.to}:${stmt.text ? ` ${stmt.text}` : ""}`;
      case "box":
        return `${i}box${stmt.color ? ` ${stmt.color}` : ""}${stmt.label ? ` ${stmt.label}` : ""}`;
      case "end":
        return `${i}end`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const a = analyse(statements);
    const nodes: GraphNode[] = [...a.participants.values()].map((p) => ({
      id: p.id,
      label: p.decl?.alias ?? p.id,
      shape: p.decl?.keyword === "actor" ? "actor" : "rect",
      parentId: p.box?.id,
      classes: [],
      styles: [],
      data: {
        declared: !!p.decl,
        ...(p.decl?.create ? { create: true } : {}),
        ...(p.decl?.config ? { config: p.decl.config } : {}),
      },
    }));
    const edges: GraphEdge[] = a.messages.map((m, index) => {
      const spec = ARROW_BY_TOKEN.get(m.stmt.arrow)!;
      return {
        id: m.edgeId,
        source: m.stmt.from,
        target: m.stmt.to,
        label: m.stmt.text,
        pattern: spec.pattern,
        arrowStart: spec.arrowStart,
        arrowEnd: spec.arrowEnd,
        length: 1,
        classes: [],
        styles: [],
        userDefinedId: false,
        data: {
          index,
          kind: m.stmt.arrow,
          activate: m.stmt.mod === "+",
          deactivate: m.stmt.mod === "-",
          ...(m.block ? { details: [m.block] } : {}),
        },
      };
    });
    const groups: GraphGroup[] = a.boxes.map((b) => ({
      id: b.id,
      label: b.stmt.label,
      classes: [],
      styles: [],
      data: b.stmt.color ? { color: b.stmt.color } : {},
    }));
    let title: string | undefined;
    let autonumber = false;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      if (s.kind === "autonumber") autonumber = !s.off;
    }
    const events = sequenceEvents(statements, a);
    const graph: DiagramGraph = {
      direction: "LR",
      nodes,
      edges,
      groups,
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
      data: { autonumber, events },
    };
    return { graph };
  },

  edit(op, ctx) {
    const emptyBefore = new Set(emptyBoxes(ctx.statements).map((b) => b.stmt));
    const handled = editSequence(op, ctx);
    if (handled) {
      repairLifecycle(ctx.statements);
      // Boxes the edit emptied (members moved or removed) go away with their `end`.
      const drop = new Set<SequenceStatement>();
      for (const b of emptyBoxes(ctx.statements))
        if (!emptyBefore.has(b.stmt)) drop.add(b.stmt).add(b.end!);
      if (drop.size) filterInPlace(ctx.statements, (s) => !drop.has(s));
    }
    return handled;
  },
};

function editSequence(
  op: Parameters<StatementGrammar<SequenceStatement>["edit"]>[0],
  ctx: EditContext<SequenceStatement>,
): boolean {
  const { statements, indent } = ctx;
  const a = analyse(statements);
  const message = (id: string) => a.messages.find((m) => m.edgeId === id)?.stmt;
  const boxById = (id: string | undefined) => a.boxes.find((b) => b.id === id);

  switch (op.type) {
    case "addNode": {
      const taken = new Set([...a.participants.keys(), ...a.boxes.map((b) => b.id)]);
      const id = uniqueId(slugId(op.node.id, "P"), taken);
      const keyword: ParticipantKeyword = op.node.shape === "actor" ? "actor" : "participant";
      const label = op.node.label?.trim() || id;
      const box = boxById(op.node.parentId);
      if (box?.end) {
        statements.splice(box.endIndex, 0, newDecl(box.stmt.indent + indent, id, keyword, label));
      } else {
        const at = declarationInsertIndex(statements, a);
        statements.splice(at, 0, newDecl(indent, id, keyword, label));
      }
      if (op.position) ctx.meta.layout![id] = op.position;
      return true;
    }
    case "renameNode":
    case "setNodeShape": {
      const info = a.participants.get(op.id);
      if (!info) return false;
      let decl = info.decl;
      if (!decl) {
        decl = newDecl(indent, op.id, "participant");
        statements.splice(declarationInsertIndex(statements, a), 0, decl);
      }
      if (op.type === "renameNode") {
        const label = op.label.trim();
        decl.alias = label && label !== op.id ? label : undefined;
      } else {
        if (op.shape !== "actor" && op.shape !== "rect") return false;
        decl.keyword = op.shape === "actor" ? "actor" : "participant";
      }
      decl.dirty = true;
      return true;
    }
    case "removeNodes": {
      const ids = new Set(op.ids.filter((id) => a.participants.has(id)));
      if (!ids.size) return false;
      filterInPlace(statements, (s) => {
        if (s.kind === "participant") return !ids.has(s.id);
        if (s.kind === "message") return !ids.has(s.from) && !ids.has(s.to);
        if (s.kind === "ref") return !s.targets.some((t) => ids.has(t.replace(/^[+-]/, "").trim()));
        return true;
      });
      dropMetaKeys(ctx.meta, ids);
      return true;
    }
    case "addEdge": {
      const { source, target } = op.edge;
      if (!source || !target) return false;
      const kind = op.edge.data?.kind;
      const arrow =
        typeof kind === "string" && ARROW_BY_TOKEN.has(kind)
          ? kind
          : arrowFor(
              op.edge.pattern ?? "solid",
              op.edge.arrowStart ?? "none",
              op.edge.arrowEnd ?? "arrow_point",
            );
      statements.push({
        kind: "message",
        raw: "",
        indent,
        from: source,
        to: target,
        arrow,
        mod: "",
        text: (op.edge.label ?? "Message").replace(/[\r\n]+/g, " ").trim(),
        dirty: true,
      });
      return true;
    }
    case "setEdgeLabel": {
      const m = message(op.id);
      if (!m) return false;
      m.text = op.label.replace(/[\r\n]+/g, " ").trim();
      m.dirty = true;
      return true;
    }
    case "setEdgeStyle": {
      const m = message(op.id);
      if (!m) return false;
      const cur = ARROW_BY_TOKEN.get(m.arrow)!;
      const pattern = op.pattern === "dotted" ? "dotted" : op.pattern ? "solid" : cur.pattern;
      m.arrow = arrowFor(pattern, op.arrowStart ?? cur.arrowStart, op.arrowEnd ?? cur.arrowEnd);
      m.dirty = true;
      return true;
    }
    case "setEdgeData": {
      const info = a.messages.find((x) => x.edgeId === op.id);
      if (!info) return false;
      const m = info.stmt;
      let changed = false;
      if (typeof op.data.kind === "string" && ARROW_BY_TOKEN.has(op.data.kind)) {
        m.arrow = op.data.kind;
        changed = true;
      }
      if (typeof op.data.deactivate === "boolean") {
        if (op.data.deactivate) m.mod = "-";
        else if (m.mod === "-") m.mod = "";
        changed = true;
      }
      if (typeof op.data.activate === "boolean") {
        if (op.data.activate) m.mod = "+";
        else if (m.mod === "+") m.mod = "";
        changed = true;
      }
      if (changed) m.dirty = true;
      if (typeof op.data.index === "number" && Number.isFinite(op.data.index)) {
        const target = Math.max(0, Math.floor(op.data.index));
        const current = a.messages.indexOf(info);
        if (target !== current) {
          statements.splice(statements.indexOf(m), 1);
          const others = a.messages.filter((x) => x !== info);
          const before = others[target]?.stmt;
          if (before) {
            statements.splice(statements.indexOf(before), 0, m);
            m.indent = before.indent;
          } else {
            statements.push(m);
            m.indent = indent;
          }
          m.dirty = true;
          changed = true;
        }
      }
      return changed;
    }
    case "reconnectEdge": {
      const m = message(op.id);
      if (!m) return false;
      m.from = op.source;
      m.to = op.target;
      m.dirty = true;
      return true;
    }
    case "removeEdges": {
      const remove = new Set(op.ids.map(message).filter(Boolean));
      if (!remove.size) return false;
      filterInPlace(statements, (s) => !remove.has(s as Message));
      return true;
    }
    case "groupNodes": {
      const ids = op.nodeIds.filter((id) => a.participants.has(id));
      if (!ids.length) return false;
      // Boxes cannot nest: insert at the first member's top-level position.
      const firstIdx = Math.min(
        ...ids.map((id) => {
          const p = a.participants.get(id)!;
          if (!p.decl) return declarationInsertIndex(statements, a);
          const idx = statements.indexOf(p.decl);
          return p.box ? p.box.index : idx;
        }),
      );
      const anchor = statements[firstIdx];
      const decls = takeDeclarations(ctx, ids, a);
      if (!decls.length) return false;
      setIndent(decls, indent + indent);
      let at = anchor ? statements.indexOf(anchor) : -1;
      if (at === -1) at = Math.min(firstIdx, statements.length);
      let label = op.label.trim() || "Box";
      if (labelLooksLikeColor(label)) label = `transparent ${label}`;
      const box = parseBoxText(label);
      statements.splice(
        at,
        0,
        { kind: "box", raw: "", indent, color: box.color, label: box.label, dirty: true },
        ...decls,
        { kind: "end", raw: "", indent, dirty: true },
      );
      return true;
    }
    case "ungroup": {
      const box = boxById(op.groupId);
      if (!box?.end) return false;
      setIndent(statements.slice(box.index + 1, box.endIndex), box.stmt.indent);
      filterInPlace(statements, (s) => s !== box.stmt && s !== box.end);
      dropMetaKeys(ctx.meta, [box.id]);
      return true;
    }
    case "renameGroup": {
      const box = boxById(op.id);
      if (!box) return false;
      const label = op.label.trim();
      // Keep an explicit colour; otherwise protect labels Mermaid would read as one.
      if (!box.stmt.color && labelLooksLikeColor(label)) box.stmt.color = "transparent";
      box.stmt.label = label;
      box.stmt.dirty = true;
      const others = new Set([
        ...a.participants.keys(),
        ...a.boxes.filter((b) => b !== box).map((b) => b.id),
      ]);
      renameMetaKey(ctx.meta, box.id, uniqueId(slugId(label, "box"), others));
      return true;
    }
    case "setNodeParent": {
      const box = op.parentId ? boxById(op.parentId) : undefined;
      if (op.parentId && !box?.end) return false;
      const ids = op.ids.filter((id) => {
        const p = a.participants.get(id);
        return p && p.box?.id !== box?.id && !p.decl?.create;
      });
      if (!ids.length) return false;
      if (box?.end) {
        const decls = takeDeclarations(ctx, ids, a);
        setIndent(decls, box.stmt.indent + indent);
        statements.splice(statements.indexOf(box.end), 0, ...decls);
      } else {
        // Out of their boxes: right after the box each one leaves.
        for (const id of ids) {
          const p = a.participants.get(id)!;
          if (!p.decl || !p.box?.end) continue;
          statements.splice(statements.indexOf(p.decl), 1);
          setIndent([p.decl], p.box.stmt.indent);
          statements.splice(statements.indexOf(p.box.end) + 1, 0, p.decl);
        }
      }
      return true;
    }
    case "setTitle": {
      const idx = statements.findIndex((s) => s.kind === "title");
      const title = op.title?.trim();
      if (idx === -1 && typeof ctx.doc.preamble.frontmatter?.title === "string") {
        ctx.setPreambleLines(setFrontmatterTitle(ctx.doc.preamble.lines, title || undefined));
        return true;
      }
      if (!title) {
        if (idx !== -1) statements.splice(idx, 1);
        return true;
      }
      if (idx !== -1) {
        const s = statements[idx] as Of<"title">;
        s.title = title;
        s.dirty = true;
      } else
        statements.unshift({ kind: "title", raw: "", indent, title, colon: false, dirty: true });
      return true;
    }
    case "setGraphData": {
      if (typeof op.data.autonumber !== "boolean") return false;
      if (!op.data.autonumber) {
        filterInPlace(statements, (s) => s.kind !== "autonumber");
        return true;
      }
      const existing = statements.filter((s): s is Of<"autonumber"> => s.kind === "autonumber");
      if (existing.length) {
        for (const s of existing)
          if (s.off) {
            s.off = false;
            s.dirty = true;
          }
      } else statements.unshift({ kind: "autonumber", raw: "", indent, off: false, dirty: true });
      return true;
    }
    default:
      return false;
  }
}

export const sequenceAdapter = createStatementAdapter(sequenceGrammar);

/**
 * Participants sit in one row in diagram order with Mermaid's box sizes;
 * boxes span the full height of the lifelines (see {@link sequenceGeometry}).
 */
registerFamilyLayout("sequence", (graph) => {
  const g = sequenceGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const col of g.columns.values()) {
    positions[col.id] = [col.x, 0];
    sizes[col.id] = { width: col.width, height: SEQUENCE_METRICS.actorHeight };
  }
  for (const [id, box] of g.boxes) {
    positions[id] = [box.x, box.y];
    sizes[id] = { width: box.width, height: box.height };
  }
  return { positions, sizes };
});

export { sequenceGeometry, SEQUENCE_METRICS, type SequenceEvent } from "./geometry.js";
