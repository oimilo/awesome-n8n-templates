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
const STOPWORDS = new Set([
  'a','an','the','and','or','to','for','with','of','in','on','by','from','about','into','as','at','is','are',
  'de','do','da','das','dos','para','com','no','na','nos','nas','um','uma','como','que','o','os','as','e',
  'setup','build','create','make','how','guide','tutorial','example','agent','bot','workflow','flow'
]);

const SOFT_STOPWORDS = new Set(['google','ai','openai','gemini','mistral','assistant','gpt']);

const SYNONYMS = new Map([
  ['gcal','calendar'],
  ['calendario','calendar'],
  ['calendário','calendar'],
  ['cal','calendar'],
  ['yt','youtube'],
  ['ig','instagram'],
  ['wa','whatsapp'],
  ['x','twitter']
]);
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/\s+/g, ' ') // collapse spaces
    .trim();
}

function canonicalizeToken(tok) {
  const n = normalize(tok);
  return SYNONYMS.get(n) || n;
}

function rankItem(tokens, item, opts) {
  const nameN = normalize(item.name);
  const relN = normalize(item.relativePath);
  const catN = normalize(item.category || '');
  const phrase = normalize(tokens.join(' '));

  let score = 0;
  let matched = 0;
  for (const t of tokens) {
    let hit = false;
    if (nameN.includes(t)) { score += 5; hit = true; }
    if (relN.includes(t)) { score += 3; hit = true; }
    if (catN.includes(t)) { score += 2; hit = true; }
    if (hit) matched++;
  }
  if (matched === tokens.length) score += 3; // all terms matched
  if (phrase && nameN.includes(phrase)) score += 2; // phrase match in name
  if (opts && opts.dir) {
    const dirN = normalize(opts.dir);
    if (catN === dirN) score += 4;
    if (relN.startsWith(dirN + '/')) score += 3;
  }
  return score;
}

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

async function ensureIndexBuilt() {
  if (!templatesIndex.length) {
    await buildIndex();
  }
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
    await ensureIndexBuilt();
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
    await ensureIndexBuilt();
    const qRaw = (req.query.q || '').toString().trim();
    const qMode = ((req.query.q_mode || '').toString().toLowerCase() === 'all') ? 'all' : 'any';
    const q = qRaw.toLowerCase();
    const dir = (req.query.dir || '').toString().trim();
    // pagination aliases (per_page/page)
    let limit = req.query.limit || req.query.per_page;
    let offset = req.query.offset;
    const page = req.query.page ? parseInt(req.query.page, 10) : null;
    if (page && !offset) {
      const limitNum = parseInt(limit || '50', 10) || 50;
      offset = (Math.max(page, 1) - 1) * limitNum;
    }

    let filtered = templatesIndex;
    if (dir) {
      const dirNorm = dir.replace(/[\\/]+/g, path.sep);
      filtered = filtered.filter(t => t.relativePath.startsWith(dirNorm + path.sep) || t.category === dir);
    }
    let tokensUsed = [];
    let simplifiedTo = '';
    if (q) {
      const rawTokens = q
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .map(s => s.trim())
        .filter(Boolean);

      let tokens = Array.from(new Set(rawTokens
        .map(canonicalizeToken)
        .filter(s => s.length > 1 && !STOPWORDS.has(s))));

      // If we still have too many generic tokens, keep the strongest
      if (tokens.length > 2) {
        tokens = tokens.filter(t => !SOFT_STOPWORDS.has(t));
        if (tokens.length === 0) tokens = rawTokens.map(canonicalizeToken);
      }

      tokensUsed = tokens;

      const haystack = (t) => normalize(`${t.name} ${t.relativePath} ${t.category}`);

      const matches = (toks, t) => {
        const hay = haystack(t);
        return qMode === 'all' ? toks.every(tok => hay.includes(tok)) : toks.some(tok => hay.includes(tok));
      };

      let prelim = tokens.length ? filtered.filter(t => matches(tokens, t)) : filtered;

      // Fallback: if no results and multi-term, try the strongest single token
      if (!prelim.length && tokens.length > 1) {
        const strong = tokens.find(t => !SOFT_STOPWORDS.has(t)) || tokens[0];
        simplifiedTo = strong;
        prelim = filtered.filter(t => haystack(t).includes(strong));
      }

      // Rank by weighted score
      prelim.sort((a, b) => rankItem(tokens, b, { dir }) - rankItem(tokens, a, { dir }));
      filtered = prelim;
    }
    const { slice, meta } = pickPagination(filtered, limit, offset);

    // fields selection
    const allowedFields = new Set(['id','name','relativePath','size','mtimeMs','category','downloadUrl','rawUrl']);
    const fieldsParam = (req.query.fields || '').toString().trim();
    const requestedFields = fieldsParam
      ? fieldsParam.split(',').map(s => s.trim()).filter(s => allowedFields.has(s))
      : null; // null = default full set

    const makeUrl = (p) => p;
    const abs = ['1','true','yes'].includes((req.query.abs || '').toString().toLowerCase());
    const base = abs ? `${req.protocol}://${req.get('host')}` : '';

    const items = slice.map(t => {
      const full = {
        id: t.id,
        name: t.name,
        relativePath: t.relativePath,
        size: t.size,
        mtimeMs: t.mtimeMs,
        category: t.category,
        downloadUrl: makeUrl(`${base}/download?id=${t.id}`),
        rawUrl: makeUrl(`${base}/raw?id=${t.id}`)
      };
      if (!requestedFields) return full;
      const slim = {};
      for (const f of requestedFields) slim[f] = full[f];
      return slim;
    });

    const view = (req.query.view || '').toString();
    if (view === 'items') {
      res.json(items);
      return;
    }

    const metaExtra = {};
    if (tokensUsed.length) metaExtra.tokens = tokensUsed;
    if (simplifiedTo) metaExtra.simplifiedTo = simplifiedTo;
    res.json({ ...meta, ...metaExtra, items });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: String(err && err.message || err) });
  }
});

function normalizeDirParam(dir) {
  if (!dir) return '';
  const norm = dir.toString().trim().replace(/[\\/]+/g, path.sep);
  return norm.replace(new RegExp(`${path.sep}+$`), '');
}

async function findByFilename(filename, dir) {
  await ensureIndexBuilt();
  const nameLc = filename.toLowerCase();
  let candidates = templatesIndex.filter(t => t.name.toLowerCase() === nameLc);
  if (dir) {
    const dirNorm = normalizeDirParam(dir);
    const dirLc = dirNorm.toLowerCase();
    candidates = candidates.filter(t =>
      t.category.toLowerCase() === dirLc ||
      t.relativePath.toLowerCase().startsWith(dirLc + path.sep)
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const locations = candidates.map(c => c.relativePath);
  const err = new Error('ambiguous_filename');
  err.details = { matches: locations };
  throw err;
}

async function resolveByQuery(req) {
  const id = (req.query.id || '').toString();
  const fileParam = (req.query.file || '').toString();
  const filenameParam = (req.query.filename || '').toString();
  const dirParam = (req.query.dir || '').toString();

  // Prefer explicit id
  if (id) {
    try {
      const relativePath = fromBase64Url(id);
      const absolutePath = path.resolve(REPO_ROOT, relativePath);
      if (!isSubPath(REPO_ROOT, absolutePath)) throw new Error('invalid_path');
      return { relativePath, absolutePath };
    } catch (_) {
      throw new Error('invalid_id');
    }
  }

  // file can be a relative path OR just a filename
  if (fileParam) {
    const looksLikePath = fileParam.includes('/') || fileParam.includes('\\');
    if (looksLikePath) {
      const relativePath = fileParam;
      const absolutePath = path.resolve(REPO_ROOT, relativePath);
      if (!isSubPath(REPO_ROOT, absolutePath)) throw new Error('invalid_path');
      return { relativePath, absolutePath };
    }
    const found = await findByFilename(fileParam, dirParam);
    if (!found) throw new Error('file_not_found');
    return { relativePath: found.relativePath, absolutePath: found.absolutePath };
  }

  // explicit filename parameter
  if (filenameParam) {
    const found = await findByFilename(filenameParam, dirParam);
    if (!found) throw new Error('file_not_found');
    return { relativePath: found.relativePath, absolutePath: found.absolutePath };
  }

  throw new Error('missing_file');
}

app.get('/raw', async (req, res) => {
  try {
    const { absolutePath } = await resolveByQuery(req);
    await fsp.access(absolutePath, fs.constants.R_OK);
    res.type('application/json');
    res.sendFile(absolutePath);
  } catch (err) {
    res.status(400).json({ error: 'raw_failed', message: String(err && err.message || err), details: err && err.details });
  }
});

app.get('/download', async (req, res) => {
  try {
    const { absolutePath } = await resolveByQuery(req);
    await fsp.access(absolutePath, fs.constants.R_OK);
    res.download(absolutePath);
  } catch (err) {
    res.status(400).json({ error: 'download_failed', message: String(err && err.message || err), details: err && err.details });
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


