#!/usr/bin/env node
/**
 * Google Merchant Center product-status report.
 *
 * Reads only. Never writes a product, price or feed -- Becky's standing rule on
 * this account is "do not change any products or prices".
 *
 *   node scripts/merchant-report.mjs              summary of item-level issues
 *   node scripts/merchant-report.mjs --issue image_too_big   list affected items
 *
 * Auth reuses the same service account as the GSC scripts
 * (~/.config/gsc/beckywexlin.json). It must be added as a user in Merchant
 * Center -> Settings -> People and access.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY_PATH = path.join(os.homedir(), '.config/gsc/beckywexlin.json');
const SCOPE = 'https://www.googleapis.com/auth/content';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function token() {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256')
    .update(`${header}.${claim}`).sign(key.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function api(tok, url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const tok = await token();

// authinfo tells us which merchant IDs this service account can actually see,
// so the ID never has to be hardcoded.
const info = await api(tok, 'https://shoppingcontent.googleapis.com/content/v2.1/accounts/authinfo');
const ids = (info.accountIdentifiers || []).map(a => a.merchantId || a.aggregatorId).filter(Boolean);
if (!ids.length) {
  console.error('No merchant accounts visible to', KEY_PATH);
  console.error('Add the service account under Merchant Center -> Settings -> People and access.');
  process.exit(1);
}
const merchantId = process.env.MERCHANT_ID || ids[0];
console.log(`Merchant account ${merchantId}${ids.length > 1 ? ` (of ${ids.join(', ')})` : ''}\n`);

// Page through every product status.
const statuses = [];
let pageToken = '';
do {
  const url = `https://shoppingcontent.googleapis.com/content/v2.1/${merchantId}/productstatuses`
    + `?maxResults=250${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const page = await api(tok, url);
  statuses.push(...(page.resources || []));
  pageToken = page.nextPageToken || '';
} while (pageToken);

const wanted = process.argv.includes('--issue')
  ? process.argv[process.argv.indexOf('--issue') + 1]
  : null;

const byCode = new Map();
for (const s of statuses) {
  for (const issue of s.itemLevelIssues || []) {
    if (!byCode.has(issue.code)) {
      byCode.set(issue.code, { code: issue.code, servability: issue.servability, description: issue.description, items: [], seen: new Set() });
    }
    // The API repeats an issue once per destination (Shopping ads, free
    // listings). Count each offer once.
    const g = byCode.get(issue.code);
    if (g.seen.has(s.productId)) continue;
    g.seen.add(s.productId);
    g.items.push({ id: s.productId, title: s.title, detail: issue.detail });
  }
}

console.log(`${statuses.length} product statuses\n`);

if (wanted) {
  const g = byCode.get(wanted);
  if (!g) { console.log(`No items with issue "${wanted}"`); process.exit(0); }
  console.log(`${g.code} — ${g.description}  (${g.items.length} items, ${g.servability})\n`);
  for (const it of g.items) console.log(`  ${(it.title || it.id).slice(0, 78)}`);
  process.exit(0);
}

const rows = [...byCode.values()].sort((a, b) => b.items.length - a.items.length);
console.log('count  servability   code');
console.log('-----  ------------  ----------------------------------------');
for (const r of rows) {
  console.log(`${String(r.items.length).padStart(5)}  ${(r.servability || '').padEnd(12)}  ${r.code}`);
}
console.log(`\n${rows.reduce((n, r) => n + r.items.length, 0)} item-level issues across ${statuses.length} products`);

// What actually matters commercially: is the offer serving anywhere?
const tally = {};
for (const st of statuses) {
  for (const d of st.destinationStatuses || []) {
    const dest = d.destination || 'unknown';
    tally[dest] = tally[dest] || { approved: 0, disapproved: 0, pending: 0 };
    if (d.approvedCountries?.length) tally[dest].approved++;
    if (d.disapprovedCountries?.length) tally[dest].disapproved++;
    if (d.pendingCountries?.length) tally[dest].pending++;
  }
}
console.log('\ndestination        approved  disapproved  pending');
console.log('-----------------  --------  -----------  -------');
for (const [dest, t] of Object.entries(tally)) {
  console.log(`${dest.padEnd(17)}  ${String(t.approved).padStart(8)}  ${String(t.disapproved).padStart(11)}  ${String(t.pending).padStart(7)}`);
}
