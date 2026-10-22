#!/usr/bin/env node
// Creates GitHub Releases for published package tags, copying the corresponding
// section from each package's CHANGELOG.md into the release body.
//
// Usage:
//   node scripts/create-github-releases.mjs              # Releases all tags pointing at HEAD
//   node scripts/create-github-releases.mjs --tag <tag>  # Releases a single tag
//   node scripts/create-github-releases.mjs --backfill   # Releases all tags missing GitHub releases
//   node scripts/create-github-releases.mjs --dry-run    # Preview without creating releases

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Map package names to their directories by reading packages/*/package.json
export function getPackageMap(baseDir = rootDir) {
  const packageMap = new Map();
  const packagesDir = path.join(baseDir, "packages");
  if (!fs.existsSync(packagesDir)) return packageMap;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        if (pkgJson.name) {
          packageMap.set(pkgJson.name, path.join(packagesDir, entry.name));
        }
      } catch (err) {
        console.warn(`Failed to parse ${pkgJsonPath}:`, err);
      }
    }
  }
  return packageMap;
}

// Extract the changelog section for a given version from CHANGELOG.md
export function extractChangelogSection(changelogContent, version) {
  if (!changelogContent) return "";
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `## \\b${escapedVersion}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const match = changelogContent.match(regex);
  return match ? match[1].trim() : "";
}

export function parseTag(tag) {
  const atIndex = tag.lastIndexOf("@");
  if (atIndex <= 0) return null;
  const name = tag.slice(0, atIndex);
  const version = tag.slice(atIndex + 1);
  return { name, version };
}

export function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function getTagsToProcess(options) {
  if (options.singleTag) {
    return [options.singleTag];
  }

  if (options.backfill) {
    const raw = execFileSync("git", ["tag", "--list", "@pixerate/*"], {
      encoding: "utf8",
    });
    return raw
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Default: tags pointing at HEAD
  const raw = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    encoding: "utf8",
  });
  return raw
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

function createRelease(tag, packageMap, options) {
  const parsed = parseTag(tag);
  if (!parsed) {
    console.log(`Skipping tag '${tag}' (not in '<package>@<version>' format).`);
    return true;
  }

  if (releaseExists(tag)) {
    console.log(`Release for '${tag}' already exists on GitHub.`);
    return true;
  }

  const pkgDir = packageMap.get(parsed.name);
  let notes = "";
  if (pkgDir) {
    const changelogPath = path.join(pkgDir, "CHANGELOG.md");
    if (fs.existsSync(changelogPath)) {
      const changelogContent = fs.readFileSync(changelogPath, "utf8");
      notes = extractChangelogSection(changelogContent, parsed.version);
    }
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would create GitHub release for '${tag}'`);
    if (notes) {
      console.log(`--- Notes preview ---\n${notes}\n---------------------`);
    } else {
      console.log(`(no changelog entry found, would use --generate-notes)`);
    }
    return true;
  }

  console.log(`Creating GitHub release for '${tag}'...`);
  const ghArgs = ["release", "create", tag, "--title", tag];

  let tempFile = null;
  if (notes) {
    tempFile = path.join(
      os.tmpdir(),
      `release-notes-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    );
    fs.writeFileSync(tempFile, notes, "utf8");
    ghArgs.push("--notes-file", tempFile);
  } else {
    ghArgs.push("--generate-notes");
  }

  try {
    execFileSync("gh", ghArgs, { stdio: "inherit" });
    console.log(`Successfully created release for '${tag}'.`);
    return true;
  } catch (err) {
    console.error(`Failed to create release for '${tag}':`, err);
    return false;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // ignore
      }
    }
  }
}

export async function run(cliArgs = process.argv.slice(2)) {
  const dryRun = cliArgs.includes("--dry-run");
  const backfill = cliArgs.includes("--backfill");

  const getFlag = (flag) => {
    const index = cliArgs.indexOf(flag);
    return index !== -1 && index + 1 < cliArgs.length
      ? cliArgs[index + 1]
      : null;
  };

  const singleTag = getFlag("--tag");
  const limitStr = getFlag("--limit");
  const limit = limitStr ? parseInt(limitStr, 10) : Infinity;

  const options = { dryRun, backfill, singleTag, limit };
  const packageMap = getPackageMap();
  const allTags = getTagsToProcess(options);

  if (allTags.length === 0) {
    console.log("No tags to process.");
    return true;
  }

  console.log(`Found ${allTags.length} tag(s) to process.`);
  let processed = 0;
  let hasErrors = false;

  for (const tag of allTags) {
    if (processed >= limit) {
      console.log(`Reached limit of ${limit} release(s). Stopping.`);
      break;
    }

    const success = createRelease(tag, packageMap, options);
    if (!success) {
      hasErrors = true;
    }
    processed++;
  }

  return !hasErrors;
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  run().then((ok) => {
    if (!ok) process.exit(1);
  });
}
