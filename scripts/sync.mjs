// Pulls brawler data from the Brawlify API (api.brawlapi.com), downloads every
// portrait / star power / gadget image into ./public/images, and writes ./public/data/brawlers.json.

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_URL = 'https://api.brawlapi.com/v1/brawlers';
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 8;

const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC, 'data');

// If the API ever exposes these on a brawler, they are picked up automatically.
const EXTRA_KEYS = {
  hyperCharges: 'hypercharges',
  hypercharges: 'hypercharges',
  buffies: 'buffies',
  buffs: 'buffies',
  gears: 'gears',
};

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep only <br> and a plain highlight span; escape everything else.
function safeHtml(html = '') {
  const unescaped = html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return unescaped
    .replace(/<br\s*\/?>/gi, '\u0001')
    .replace(/<span[^>]*>/gi, '\u0002')
    .replace(/<\/span>/gi, '\u0003')
    .replace(/<[^>]*>/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\u0001/g, '<br>')
    .replace(/\u0002/g, '<span class="hl">')
    .replace(/\u0003/g, '</span>');
}

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(400 * i);
    }
  }
  throw new Error(`${url} -> ${lastErr.message}`);
}

const failures = [];
let downloaded = 0;
let skipped = 0;

async function saveImage(url, kind, id) {
  if (!url) return null;
  const dir = path.join(PUBLIC, 'images', kind);
  const file = path.join(dir, `${id}.png`);
  const webPath = `images/${kind}/${id}.png`;
  if (!FORCE && (await exists(file))) {
    skipped++;
    return webPath;
  }
  try {
    await mkdir(dir, { recursive: true });
    const res = await fetchWithRetry(url);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    downloaded++;
    return webPath;
  } catch (err) {
    failures.push(err.message);
    return null;
  }
}

async function pool(tasks, limit) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        await tasks[i]();
      }
    }),
  );
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  console.log('Fetching brawlers from', API_URL);
  const body = await (await fetchWithRetry(API_URL)).json();
  const list = body.list ?? [];
  if (!list.length) throw new Error('API returned no brawlers');

  const tasks = [];
  const brawlers = list.map((b) => {
    const out = {
      id: b.id,
      name: b.name,
      slug: b.path,
      released: b.released !== false,
      class: b.class?.name ?? 'Unknown',
      rarity: { name: b.rarity?.name ?? 'Unknown', color: b.rarity?.color ?? '#888888' },
      description: b.description ?? '',
      descHtml: safeHtml(b.descriptionHtml ?? b.description ?? ''),
      image: null,
      starPowers: [],
      gadgets: [],
    };
    tasks.push(async () => { out.image = await saveImage(b.imageUrl2 || b.imageUrl, 'brawlers', b.id); });

    for (const sp of b.starPowers ?? []) {
      const item = { id: sp.id, name: sp.name, description: sp.description ?? '', descHtml: safeHtml(sp.descriptionHtml ?? sp.description ?? ''), image: null };
      out.starPowers.push(item);
      tasks.push(async () => { item.image = await saveImage(sp.imageUrl, 'star-powers', sp.id); });
    }
    for (const g of b.gadgets ?? []) {
      const item = { id: g.id, name: g.name, description: g.description ?? '', descHtml: safeHtml(g.descriptionHtml ?? g.description ?? ''), image: null };
      out.gadgets.push(item);
      tasks.push(async () => { item.image = await saveImage(g.imageUrl, 'gadgets', g.id); });
    }
    for (const [key, label] of Object.entries(EXTRA_KEYS)) {
      const arr = b[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      out[label] ??= [];
      for (const x of arr) {
        if (!x || typeof x !== 'object' || x.id == null) continue;
        const item = { id: x.id, name: x.name ?? '', description: x.description ?? '', descHtml: safeHtml(x.descriptionHtml ?? x.description ?? ''), image: null };
        out[label].push(item);
        tasks.push(async () => { item.image = await saveImage(x.imageUrl, label, x.id); });
      }
    }
    return out;
  });

  console.log(`Downloading images for ${brawlers.length} brawlers (${tasks.length} files)...`);
  await pool(tasks, CONCURRENCY);

  brawlers.sort((a, b) => b.id - a.id); // newest first

  await writeFile(
    path.join(DATA_DIR, 'brawlers.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: 'api.brawlapi.com', count: brawlers.length, brawlers }, null, 2),
  );

  console.log(`Done. ${brawlers.length} brawlers, ${downloaded} images downloaded, ${skipped} already present.`);
  if (failures.length) {
    console.warn(`${failures.length} image(s) failed (the site shows a placeholder for them). Re-run to retry:`);
    failures.slice(0, 10).forEach((f) => console.warn('  -', f));
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
