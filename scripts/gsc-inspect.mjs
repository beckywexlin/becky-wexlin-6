#!/usr/bin/env node
/**
 * Search Console URL Inspection — is Google actually indexing this page?
 *
 * Impressions of zero are ambiguous: the page might rank badly, or Google might
 * never have indexed it at all. Those need opposite fixes, and only this API
 * tells them apart.
 *
 *   node scripts/gsc-inspect.mjs /collections/funny-t-shirts /shop
 *   node scripts/gsc-inspect.mjs --collections
 *   node scripts/gsc-inspect.mjs --sitemap 20      first 20 sitemap URLs
 *
 * Quota is 2000 inspections/day and 600/minute per property, so this paces
 * itself rather than firing everything at once.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const KEY_PATH = process.env.GSC_KEY || path.join(os.homedir(), '.config/gsc/beckywexlin.json');
const SITE = process.env.GSC_SITE || 'sc-domain:beckywexlin.com';
const ORIGIN = 'https://www.beckywexlin.com';

const COLLECTIONS = [
  'graphic-tees', 'funny-t-shirts', 'skull-t-shirts', 'animal-t-shirts',
  'santa-barbara-t-shirts', 'meme-t-shirts', 'mens-graphic-tees',
  'womens-graphic-tees', 'alien-t-shirts', 'cowboy-t-shirts',
].map(s => `/collections/${s}`).concat('/collections/');

const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let tok = null;
async function accessToken() {
  if (tok && tok.exp > Date.now() / 1000 + 60) return tok.value;
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${h}.${c}`);
  const jwt = `${h}.${c}.${b64url(s.sign(key.private_key))}`;
  const j = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt,
    }),
  })).json();
  if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j));
  tok = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return tok.value;
}

async function inspect(url) {
  const t = await accessToken();
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE, languageCode: 'en-US' }),
  });
  const j = await res.json();
  if (j.error) return { error: j.error.message };
  return j.inspectionResult || {};
}

async function main() {
  const argv = process.argv.slice(2);
  let paths = argv.filter(a => a.startsWith('/'));

  if (argv.includes('--collections')) paths = COLLECTIONS;
  if (argv.includes('--sitemap')) {
    const n = Number(argv[argv.indexOf('--sitemap') + 1]) || 25;
    const xml = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
    paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1].replace(ORIGIN, '')).slice(0, n);
  }
  if (!paths.length) {
    console.error('give paths, or --collections, or --sitemap N');
    process.exit(1);
  }

  console.log(`Inspecting ${paths.length} URLs against ${SITE}\n`);
  const rows = [];
  for (const p of paths) {
    const r = await inspect(ORIGIN + p);
    if (r.error) { rows.push([p, 'ERROR', r.error.slice(0, 60), '', '']); continue; }
    const i = r.indexStatusResult || {};
    rows.push([
      p,
      i.verdict || '?',
      i.coverageState || '?',
      (i.lastCrawlTime || '').slice(0, 10) || 'never',
      i.robotsTxtState === 'DISALLOWED' ? 'BLOCKED' : (i.indexingState || ''),
    ]);
    await new Promise(r2 => setTimeout(r2, 150));   // stay under 600/min
  }

  const head = ['url', 'verdict', 'coverage', 'last crawl', 'indexing'];
  const w = head.map((_, k) => Math.max(...[head, ...rows].map(r => String(r[k] || '').length)));
  const line = (r) => r.map((c, k) => String(c || '').padEnd(w[k])).join('  ');
  console.log(line(head));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  rows.forEach(r => console.log(line(r)));

  const notIndexed = rows.filter(r => r[1] !== 'PASS');
  console.log(`\n${rows.length - notIndexed.length}/${rows.length} indexed`);
  if (notIndexed.length) {
    console.log('not indexed:');
    notIndexed.forEach(r => console.log(`  ${r[0]} — ${r[2]}`));
  }
}

main().catch(e => { console.error('\n' + e.message + '\n'); process.exit(1); });
