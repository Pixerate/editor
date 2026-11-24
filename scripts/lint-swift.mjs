import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TARGET_DIRS = ["packages/swift", "apps/swift-demo"];
const IGNORED_DIRS = new Set([".build", "node_modules", ".git", "DerivedData"]);

function collectSwiftFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectSwiftFiles(full));
    } else if (entry.endsWith(".swift")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Replace comments and string literals with spaces while preserving newlines
 * so line numbers and brace depth inside code remain exact.
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Line comment
    if (ch === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    // Block comment (supports nesting in Swift)
    if (ch === "/" && next === "*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          out += "  ";
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
        } else {
          out += source[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
      continue;
    }
    // Multiline string literal """..."""
    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
      out += "   ";
      i += 3;
      while (i < n) {
        if (source[i] === "\\" && i + 1 < n) {
          out += source[i + 1] === "\n" ? " \n" : "  ";
          i += 2;
          continue;
        }
        if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
          out += "   ";
          i += 3;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    // Single-line string literal "..."
    if (ch === '"') {
      out += " ";
      i++;
      while (i < n && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          out += " ";
          i++;
          break;
        }
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function hasAttributeBefore(lines, lineIdx, attrRegex) {
  if (attrRegex.test(lines[lineIdx])) return true;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (attrRegex.test(lines[i])) return true;
    if (trimmed.startsWith("@") || trimmed.startsWith(")") || trimmed.endsWith(",")) continue;
    break;
  }
  return false;
}

export function lintSwiftSource(source, relPath) {
  const errors = [];
  const clean = stripCommentsAndStrings(source);
  const lines = clean.split("\n");
  const isPackageSource = relPath.startsWith("packages/swift/Sources/");

  // 1. Ban PreviewProvider
  for (let i = 0; i < lines.length; i++) {
    if (/:\s*PreviewProvider\b/.test(lines[i])) {
      errors.push(`${relPath}:${i + 1}: Use #Preview instead of legacy PreviewProvider.`);
    }
  }

  // 2. Ban (.Binding)?.constant(...) inside #Preview blocks
  let inPreviewHeader = false;
  let parenDepth = 0;
  let inPreviewBody = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check line-by-line within #Preview body
    for (let j = 0; j < line.length; j++) {
      if (!inPreviewBody && !inPreviewHeader) {
        if (line.startsWith("#Preview", j) && (j === 0 || !/\w/.test(line[j - 1])) && !/\w/.test(line[j + 8] ?? "")) {
          inPreviewHeader = true;
          parenDepth = 0;
          j += 7;
          continue;
        }
      } else if (inPreviewHeader) {
        const ch = line[j];
        if (ch === "(") parenDepth++;
        else if (ch === ")" && parenDepth > 0) parenDepth--;
        else if (ch === "{" && parenDepth === 0) {
          inPreviewHeader = false;
          inPreviewBody = true;
          braceDepth = 1;
        }
      } else if (inPreviewBody) {
        const ch = line[j];
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          if (braceDepth === 0) {
            inPreviewBody = false;
          }
        }
      }
    }

    if (inPreviewBody || (inPreviewHeader === false && /#Preview\b/.test(line))) {
      // If #Preview starts and opens/closes on the same line, check the slice inside #Preview's braces
      if (inPreviewBody && /(\bBinding)?\.constant\s*\(/.test(line)) {
        errors.push(`${relPath}:${i + 1}: Use @Previewable with @State/@Bindable instead of .constant(...) inside #Preview.`);
      } else if (!inPreviewBody && /#Preview\b[\s\S]*\{[\s\S]*(\bBinding)?\.constant\s*\(/.test(line)) {
        errors.push(`${relPath}:${i + 1}: Use @Previewable with @State/@Bindable instead of .constant(...) inside #Preview.`);
      }
    }
  }

  // 3. In packages/swift/Sources/**/*.swift, check @available on PreviewModifier and #Preview(arguments:)
  if (isPackageSource) {
    const avail15 = /@available\s*\(\s*macOS\s+15(?:\.0)?\s*,\s*iOS\s+18(?:\.0)?\s*,\s*\*\s*\)/;
    const avail27 = /@available\s*\(\s*macOS\s+27(?:\.0)?\s*,\s*iOS\s+26(?:\.0)?\s*,\s*\*\s*\)/;

    for (let i = 0; i < lines.length; i++) {
      if (/\b(?:struct|class|enum|actor)\b[^:\n]*:\s*[^{\n]*\bPreviewModifier\b/.test(lines[i])) {
        if (!hasAttributeBefore(lines, i, avail15)) {
          errors.push(`${relPath}:${i + 1}: PreviewModifier declaration must be marked @available(macOS 15, iOS 18, *).`);
        }
      }
      if (/#Preview\s*\(\s*arguments\s*:/.test(lines[i])) {
        if (!hasAttributeBefore(lines, i, avail27)) {
          errors.push(`${relPath}:${i + 1}: #Preview(arguments:) must be marked @available(macOS 27, iOS 26, *).`);
        }
      }
    }
  }

  return errors;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  const files = TARGET_DIRS.flatMap((dir) => collectSwiftFiles(join(ROOT, dir)));
  const allErrors = [];
  for (const file of files) {
    const relPath = relative(ROOT, file).replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");
    allErrors.push(...lintSwiftSource(source, relPath));
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) {
      console.error(err);
    }
    process.exit(1);
  }
  console.log(`lint-swift: ${files.length} Swift files checked, no issues.`);
}
