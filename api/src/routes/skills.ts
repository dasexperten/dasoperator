// =============================================================================
// /api/skills — Skills Registry
//
// Reads from R2 bucket `das-skills` (via skill-loader cache).
// Used by:
//   - UI page /skills — list all available skills + descriptions
//   - Other workers/services that need to discover what skills exist
//   - Debugging — quick check of any SKILL.md or reference file
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { loadManifest, loadSkillFile, loadSkillMd, flushSkillCache } from '../lib/skill-loader';

const app = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// GET /api/skills — list all skills with metadata
// -----------------------------------------------------------------------------
app.get('/', async (c) => {
  const manifest = await loadManifest(c.env);
  const skills = Object.entries(manifest.skills).map(([name, info]) => ({
    name,
    description: (info as any).description ?? '',
    fileCount: info.file_count,
    totalBytes: info.total_bytes,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return c.json({
    ok: true,
    version: manifest.version,
    totalSkills: skills.length,
    totalFiles: skills.reduce((s, x) => s + x.fileCount, 0),
    totalBytes: skills.reduce((s, x) => s + x.totalBytes, 0),
    skuIndexed: Object.keys(manifest.sku_index).length,
    skills,
  });
});

// -----------------------------------------------------------------------------
// GET /api/skills/:name — single skill details + file list
// -----------------------------------------------------------------------------
app.get('/:name', async (c) => {
  const name = c.req.param('name');
  const manifest = await loadManifest(c.env);
  const info = manifest.skills[name];
  if (!info) return c.json({ ok: false, error: 'skill not found' }, 404);

  return c.json({
    ok: true,
    name,
    description: (info as any).description ?? '',
    fileCount: info.file_count,
    totalBytes: info.total_bytes,
    files: info.files,
  });
});

// -----------------------------------------------------------------------------
// GET /api/skills/:name/SKILL.md — raw SKILL.md content
// -----------------------------------------------------------------------------
app.get('/:name/SKILL.md', async (c) => {
  const name = c.req.param('name');
  try {
    const md = await loadSkillMd(c.env, name);
    return c.text(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'not found' }, 404);
  }
});

// -----------------------------------------------------------------------------
// GET /api/skills/:name/file/* — fetch any reference file by relative path
// Example: /api/skills/product-skill/file/references/sku-cards/DE201-schwarz.md
// -----------------------------------------------------------------------------
app.get('/:name/file/*', async (c) => {
  const name = c.req.param('name');
  // hono's wildcard captures the rest after the file/ prefix
  const path = c.req.path.split('/file/')[1] ?? '';
  if (!path) return c.json({ ok: false, error: 'path required' }, 400);

  try {
    const key = `skills/${name}/${path}`;
    const content = await loadSkillFile(c.env, key);
    // Set mime based on extension
    const mime = path.endsWith('.md') ? 'text/markdown; charset=utf-8'
      : path.endsWith('.json') ? 'application/json; charset=utf-8'
      : path.endsWith('.html') ? 'text/html; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return c.text(content, 200, { 'Content-Type': mime });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'not found' }, 404);
  }
});

// -----------------------------------------------------------------------------
// POST /api/skills/flush-cache — invalidate KV cache (e.g. after R2 sync)
// -----------------------------------------------------------------------------
app.post('/flush-cache', async (c) => {
  const n = await flushSkillCache(c.env);
  return c.json({ ok: true, flushed: n });
});

export default app;
