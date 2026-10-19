#!/usr/bin/env node
// Downloads the public PSD test corpus used by `pnpm test:corpus` into packages/core/corpus/psd/
// (git-ignored). Sources are pinned to commits and every file is checked against the sha256 in
// tests/psd-corpus.manifest.json.
//
//   node scripts/fetch-psd-corpus.mjs                  download missing files and verify all
//   node scripts/fetch-psd-corpus.mjs --write-manifest list the pinned trees, download, hash, and
//                                                      rewrite the manifest (maintainers only)
//
// Sources (both MIT): psd-tools (tests/psd_files, without third-party-psds/) and ag-psd (test/).
// Never point this at anyone's own PSDs.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifestPath = join(root, 'tests', 'psd-corpus.manifest.json');
const corpusDir = join(root, 'corpus', 'psd');

const SOURCES = [
  {
    id: 'psd-tools',
    repo: 'psd-tools/psd-tools',
    commit: 'b1b454baa5fdc4d72e26b9b4bd29b2e8ad1fb93b',
    license: 'MIT',
    include: (p) => p.startsWith('tests/psd_files/') && !p.startsWith('tests/psd_files/third-party-psds/'),
  },
  {
    id: 'ag-psd',
    repo: 'Agamnentzar/ag-psd',
    commit: '04d927df87130ad6d765bc63d51ade0a98d66c14',
    license: 'MIT',
    include: (p) => p.startsWith('test/'),
  },
];

const isPsd = (p) => /\.(psd|psb)$/i.test(p);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBytes(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'pixerate-editor-psd-corpus' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`Could not fetch ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function listTree(source) {
  const url = `https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`;
  const headers = { 'User-Agent': 'pixerate-editor-psd-corpus', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Listing ${source.repo}@${source.commit}: ${res.status} ${res.statusText}`);
  const tree = await res.json();
  if (tree.truncated) throw new Error(`The tree of ${source.repo} is truncated; list it by folder instead.`);
  return tree.tree.filter((e) => e.type === 'blob' && isPsd(e.path) && source.include(e.path)).map((e) => e.path).sort();
}

const rawUrl = (source, path) => `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
const localPath = (sourceId, path) => join(corpusDir, sourceId, ...path.split('/'));

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(source, path) {
  const target = localPath(source.id, path);
  if (await exists(target)) return readFile(target);
  const bytes = await fetchBytes(rawUrl(source, path));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function writeManifest() {
  const files = [];
  for (const source of SOURCES) {
    const paths = await listTree(source);
    process.stdout.write(`${source.id}: ${paths.length} files\n`);
    await pool(paths, 8, async (path) => {
      const bytes = await download(source, path);
      files.push({ source: source.id, path, size: bytes.length, sha256: sha256(bytes) });
    });
  }
  files.sort((a, b) => (a.source + a.path).localeCompare(b.source + b.path));
  const manifest = {
    note: 'Public PSD corpus for `pnpm test:corpus`, fetched by scripts/fetch-psd-corpus.mjs. Do not add private files.',
    sources: SOURCES.map(({ id, repo, commit, license }) => ({ id, repo, commit, license })),
    files,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`Wrote ${files.length} entries to ${manifestPath}\n`);
}

async function verify() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bySource = new Map(SOURCES.map((s) => [s.id, s]));
  for (const s of manifest.sources) {
    const pinned = bySource.get(s.id);
    if (!pinned || pinned.commit !== s.commit) throw new Error(`Manifest source ${s.id} does not match the pinned commit; rerun with --write-manifest.`);
  }
  let fetched = 0;
  const bad = [];
  await pool(manifest.files, 8, async (f) => {
    const source = bySource.get(f.source);
    const had = await exists(localPath(f.source, f.path));
    const bytes = await download(source, f.path);
    if (!had) fetched++;
    if (sha256(bytes) !== f.sha256) bad.push(`${f.source}/${f.path}`);
  });
  if (bad.length) throw new Error(`Checksum mismatch (delete the files and rerun):\n  ${bad.join('\n  ')}`);
  process.stdout.write(`PSD corpus ready: ${manifest.files.length} files verified (${fetched} downloaded) in ${corpusDir}\n`);
}

(process.argv.includes('--write-manifest') ? writeManifest() : verify()).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
