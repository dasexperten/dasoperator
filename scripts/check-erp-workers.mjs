#!/usr/bin/env node
// Guard for workers/erp-*: one timer action per worker, no model, no key in code.
//   node scripts/check-erp-workers.mjs                    → check all, exit 1 on any finding
//   node scripts/check-erp-workers.mjs --affected a b c   → print JSON list of erp-* workers whose
//                                                           import tree contains any of the given files
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = join(ROOT, 'workers');

const MODEL_PATH = /(^|\/)lib\/(llm|anthropic|openrouter|deepseek|gemini|qwen|openai-codex)(\.[a-z]+)?$/;
const MODEL_HOST = /api\.anthropic\.com|openrouter\.ai|api\.deepseek\.com|generativelanguage\.googleapis\.com|api\.openai\.com|dashscope|api\.x\.ai|chatgpt\.com\/backend-api/;
const KEY_LITERAL = [
  /cfut[A-Za-z0-9_-]{40,}/,
  /\bgh[pous]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bre_[A-Za-z0-9]{20,}/,
  /['"]Api-Key['"]\s*:\s*['"][^'"$`]{10,}['"]/,
];

const SPEC = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
const EXTS = ['', '.ts', '.mts', '.mjs', '.js', '.json', '/index.ts', '/index.mjs', '/index.js'];

function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function graph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith('.json')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const r = resolveSpec(f, spec);
      if (r) stack.push(r);
    }
  }
  return seen;
}

function tomlField(toml, key) {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

function crons(toml) {
  const m = toml.match(/^\[triggers\][^[]*?crons\s*=\s*\[([^\]]*)\]/ms);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

const dirs = existsSync(WORKERS)
  ? readdirSync(WORKERS).filter((d) => d.startsWith('erp-') && statSync(join(WORKERS, d)).isDirectory())
  : [];

const args = process.argv.slice(2);
if (args[0] === '--affected') {
  const changed = new Set(args.slice(1).map((f) => resolve(ROOT, f)));
  const hit = dirs.filter((d) => {
    if ([...changed].some((f) => f.startsWith(join(WORKERS, d) + '/'))) return true;
    const entry = join(WORKERS, d, 'src', 'index.ts');
    return existsSync(entry) && [...graph(entry)].some((f) => changed.has(f));
  });
  process.stdout.write(JSON.stringify(hit));
  process.exit(0);
}

const findings = [];
for (const d of dirs) {
  const tomlPath = join(WORKERS, d, 'wrangler.toml');
  const entry = join(WORKERS, d, 'src', 'index.ts');
  if (!existsSync(tomlPath)) { findings.push(`${d}: no wrangler.toml`); continue; }
  if (!existsSync(entry)) { findings.push(`${d}: no src/index.ts`); continue; }
  const toml = readFileSync(tomlPath, 'utf8');
  const name = tomlField(toml, 'name');
  if (name !== d) findings.push(`${d}: wrangler name "${name}" differs from folder`);
  if (!crons(toml).length) findings.push(`${d}: no [triggers] crons — a timer worker without a timer`);
  if (tomlField(toml, 'main') !== 'src/index.ts') findings.push(`${d}: main must be src/index.ts`);

  for (const f of graph(entry)) {
    const rel = relative(ROOT, f);
    if (MODEL_PATH.test(rel.replace(/\.[a-z]+$/, ''))) findings.push(`${d}: imports a model client ${rel}`);
    if (f.endsWith('.json')) continue;
    const src = readFileSync(f, 'utf8');
    if (MODEL_HOST.test(src)) findings.push(`${d}: ${rel} calls a model host`);
    for (const re of KEY_LITERAL) if (re.test(src)) findings.push(`${d}: ${rel} holds a key literal (${re.source.slice(0, 20)}…)`);
  }
}

if (findings.length) {
  console.error('erp-workers guard: ' + findings.length + ' finding(s)');
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log(`erp-workers guard: ${dirs.length} worker(s) clean`);
