import type { MermaidDocument, DiagramMeta } from "../types.js";
import { isMetaEmpty, metaCommentLine, writeMetaToPreamble } from "../source/metadata.js";
import { compoundInfo, type FlowchartBody } from "./parse.js";
import { formatStatement, type FlowStatement } from "./statements.js";

/** Serialises statements, honouring compound (`a; b`) lines. */
export function serializeStatements(statements: FlowStatement[]): string[] {
  const out: string[] = [];
  const emitted = new Set<FlowStatement>();
  const present = new Set(statements);
  for (const stmt of statements) {
    if (emitted.has(stmt)) continue;
    const compound = compoundInfo(stmt);
    if (compound) {
      const members = compound.members.filter((m) => present.has(m));
      const complete = members.length === compound.members.length;
      const anyDirty = members.some((m) => "dirty" in m && m.dirty);
      if (complete && !anyDirty) {
        out.push(compound.raw);
        for (const member of compound.members) emitted.add(member);
        continue;
      }
      // Normalise to one statement per line; each member keeps its own text.
      const indent =
        "indent" in compound.members[0]! ? (compound.members[0] as { indent: string }).indent : "";
      for (const member of members) {
        const text = formatStatement(member);
        if (text.trim() === "") continue;
        out.push(text.startsWith(indent) ? text : indent + text.trimStart());
      }
      for (const member of compound.members) emitted.add(member);
      continue;
    }
    out.push(formatStatement(stmt));
    emitted.add(stmt);
  }
  return out;
}

/** Indentation used by the first indented body statement, defaulting to two spaces. */
export function detectIndent(statements: FlowStatement[]): string {
  for (const stmt of statements) {
    if ("indent" in stmt && stmt.indent) return stmt.indent;
  }
  return "  ";
}

/**
 * Assembles the full document text: preamble, header, metadata, body and the
 * original trailing whitespace.
 */
export function assembleDocument(
  doc: Pick<MermaidDocument, "preamble" | "header" | "trailing" | "eol" | "meta" | "metaCarrier">,
  bodyLines: string[],
  indent: string,
): string {
  const meta: DiagramMeta | null = isMetaEmpty(doc.meta) ? null : doc.meta;
  const preambleLines =
    doc.metaCarrier === "frontmatter"
      ? writeMetaToPreamble(doc.preamble, meta)
      : [...doc.preamble.lines];
  const lines = [...preambleLines];
  if (doc.header) lines.push(doc.header);
  if (meta && doc.metaCarrier === "comment") lines.push(metaCommentLine(meta, indent));
  lines.push(...bodyLines);
  return lines.join(doc.eol) + doc.trailing;
}

export function serializeFlowchart(doc: MermaidDocument<FlowchartBody>): string {
  const bodyLines = serializeStatements(doc.body.statements);
  return assembleDocument(doc, bodyLines, detectIndent(doc.body.statements));
}
