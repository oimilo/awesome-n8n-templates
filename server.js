'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 3000;
const REPO_ROOT = path.resolve(__dirname);
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const EXCLUDED_FILES = new Set(['package.json', 'package-lock.json']);

/**
 * Holds the in-memory index of JSON templates.
 * Each item: { id, name, relativePath, absolutePath, size, mtimeMs, category }
 */
let templatesIndex = [];

function toBase64Url(input) {
  const base64 = Buffer.from(input).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(base64, 'base64').toString();
}

function isSubPath(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function walkJsonFiles(startDir) {
  const results = [];
  const stack = [startDir];

  while (stack.length) {
    const current = stack.pop();
    const dirents = await fsp.readdir(current, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (EXCLUDED_DIRS.has(d.name)) continue;
        stack.push(path.join(current, d.name));
        continue;
      }
      if (!d.isFile()) continue;
      if (!d.name.toLowerCase().endsWith('.json')) continue;
      if (EXCLUDED_FILES.has(d.name)) continue;
      const absolutePath = path.join(current, d.name);
      const relativePath = path.relative(REPO_ROOT, absolutePath);
      const stat = await fsp.stat(absolutePath);
      const segments = relativePath.split(path.sep);
      const category = segments.length > 1 ? segments[0] : '';
      results.push({
        id: toBase64Url(relativePath),
        name: path.basename(relativePath),
        relativePath,
        absolutePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        category
      });
    }
  }
  return results;
}

async function buildIndex() {
  templatesIndex = await walkJsonFiles(REPO_ROOT);
  templatesIndex.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { total: templatesIndex.length };
}

function pickPagination(items, limit, offset) {
  const safeLimit = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200);
  const safeOffset = Math.max(parseInt(offset || '0', 10) || 0, 0);
  return {
    slice: items.slice(safeOffset, safeOffset + safeLimit),
    meta: { total: items.length, count: Math.min(safeLimit, Math.max(items.length - safeOffset, 0)), limit: safeLimit, offset: safeOffset }
  };
}

app.get('/health', async (req, res) => {
  try {
    if (!templatesIndex.length) await buildIndex();
    res.json({ status: 'ok', templates: templatesIndex.length, root: REPO_ROOT });
  } catch (err) {
    res.status(500).json({ error: 'health_failed', message: String(err && err.message || err) });
  }
});

app.post('/refresh', async (req, res) => {
  try {
    const result = await buildIndex();
    res.json({ status: 'refreshed', ...result });
  } catch (err) {
    res.status(500).json({ error: 'refresh_failed', message: String(err && err.message || err) });
  }
});

app.get('/templates', async (req, res) => {
  try {
    if (!templatesIndex.length) await buildIndex();
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const dir = (req.query.dir || '').toString().trim();
    let filtered = templatesIndex;
    if (dir) {
      const dirNorm = dir.replace(/[\\/]+/g, path.sep);
      filtered = filtered.filter(t => t.relativePath.startsWith(dirNorm + path.sep) || t.category === dir);
    }
    if (q) {
      filtered = filtered.filter(t => (
        t.name.toLowerCase().includes(q) ||
        t.relativePath.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      ));
    }
    const { slice, meta } = pickPagination(filtered, req.query.limit, req.query.offset);
    const items = slice.map(t => ({
      id: t.id,
      name: t.name,
      relativePath: t.relativePath,
      size: t.size,
      mtimeMs: t.mtimeMs,
      category: t.category,
      downloadUrl: `/download?id=${t.id}`,
      rawUrl: `/raw?id=${t.id}`
    }));
    res.json({ ...meta, items });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: String(err && err.message || err) });
  }
});

function resolveByIdOrPath(req) {
  const id = (req.query.id || '').toString();
  const fileParam = (req.query.file || '').toString();
  let relativePath = fileParam;
  if (id) {
    try {
      relativePath = fromBase64Url(id);
    } catch (_) {
      throw new Error('invalid_id');
    }
  }
  if (!relativePath) throw new Error('missing_file');
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  if (!isSubPath(REPO_ROOT, absolutePath)) throw new Error('invalid_path');
  return { relativePath, absolutePath };
}

app.get('/raw', async (req, res) => {
  try {
    const { absolutePath } = resolveByIdOrPath(req);
    await fsp.access(absolutePath, fs.constants.R_OK);
    res.type('application/json');
    res.sendFile(absolutePath);
  } catch (err) {
    res.status(400).json({ error: 'raw_failed', message: String(err && err.message || err) });
  }
});

app.get('/download', async (req, res) => {
  try {
    const { absolutePath } = resolveByIdOrPath(req);
    await fsp.access(absolutePath, fs.constants.R_OK);
    res.download(absolutePath);
  } catch (err) {
    res.status(400).json({ error: 'download_failed', message: String(err && err.message || err) });
  }
});

app.get('/template/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const relativePath = fromBase64Url(id);
    const absolutePath = path.resolve(REPO_ROOT, relativePath);
    if (!isSubPath(REPO_ROOT, absolutePath)) throw new Error('invalid_path');
    const content = await fsp.readFile(absolutePath, 'utf8');
    res.type('application/json').send(content);
  } catch (err) {
    res.status(400).json({ error: 'template_failed', message: String(err && err.message || err) });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Templates API listening on port ${PORT}`);
});


