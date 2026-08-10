#!/usr/bin/env node
/* ============================================================
   Google Search Console reader — beckywexlin.com
   ------------------------------------------------------------
   Reads a service-account key and queries the Search Console API.
   No dependencies; JWT is signed with node:crypto.

   The key lives OUTSIDE this repo on purpose. The Cloudflare assets
   directory is the repo root, so anything in here that isn't listed in
   .assetsignore is downloadable from the live site. (scripts/ is listed,
   but a credential still has no business in a deployed repo.)

     mkdir -p ~/.config/gsc
     mv ~/Downloads/<project>-<hash>.json ~/.config/gsc/beckywexlin.json
     chmod 600 ~/.config/gsc/beckywexlin.json

   Usage:
     node scripts/gsc.mjs sites                 list properties the key can read
     node scripts/gsc.mjs queries [days]        top search queries
     node scripts/gsc.mjs pages [days]          top landing pages
     node scripts/gsc.mjs wins [days]           queries ranking 8-20  <- the money view
     node scripts/gsc.mjs inspect <url>         has Google indexed this page?

   Override the key path with GSC_KEY=/some/other/path.json
   ============================================================ */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_PATH = process.env.GSC_KEY || join(homedir(), '.config', 'gsc', 'beckywexlin.json');
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function loadKey() {
  let raw;
  try {
    raw = readFileSync(KEY_PATH, 'utf8');
  } catch {
    console.error(`No key at ${KEY_PATH}\n`
      + `Download the service-account JSON from Google Cloud and move it there, or set GSC_KEY.`);
    process.exit(1);
  }
  const key = JSON.parse(raw);
  if (!key.client_email || !key.private_key) {
    console.error(`${KEY_PATH} doesn't look like a service-account key `
      + `(missing client_email / private_key).`);
    process.exit(1);
  }
  return key;
}

const b64 = obj => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
  .toString('base64url');

// Standard service-account flow: sign a JWT asserting who we are, trade it
// for a one-hour access token.
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(key.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    console.error('Could not get an access token:', JSON.stringify(data, null, 2));
    console.error('\nUsual causes: the Search Console API isn\'t enabled on the project, '
      + 'or the key was revoked.');
    process.exit(1);
  }
  return data.access_token;
}

async function api(token, path, body) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.error) {
    console.error(`API error ${data.error.code}: ${data.error.message}`);
    if (data.error.code === 403) {
      console.error('\nThe service account can reach the API but not this property. '
        + 'Add its email as a user in Search Console → Settings → Users and permissions.');
    }
    process.exit(1);
  }
  return data;
}

// A property is either sc-domain:example.com or https://www.example.com/ —
// resolve it rather than making the caller know which one was verified.
async function resolveSite(token) {
  if (process.env.GSC_SITE) return process.env.GSC_SITE;
  const { siteEntry = [] } = await api(token, '/sites');
  const usable = siteEntry.filter(s => s.permissionLevel !== 'siteUnverifiedUser');
  const match = usable.find(s => s.siteUrl.includes('beckywexlin'));
  if (!match) {
    console.error('No beckywexlin property this key can read. Properties visible:');
    siteEntry.forEach(s => console.error(`  ${s.siteUrl}  (${s.permissionLevel})`));
    process.exit(1);
  }
  return match.siteUrl;
}

const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);

async function search(token, site, { dimension, days, limit = 100 }) {
  const { rows = [] } = await api(token, `/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    // GSC data lags ~2 days; ending today just returns empty rows for the tail.
    startDate: daysAgo(days + 2),
    endDate: daysAgo(2),
    dimensions: [dimension],
    rowLimit: limit,
  });
  return rows;
}

function table(rows, label) {
  if (!rows.length) return console.log('  (no data — the property may be new, or too few impressions)');
  console.log(`  ${pad(label, 52)} ${'clicks'.padStart(7)} ${'impr'.padStart(8)} ${'ctr'.padStart(7)} ${'pos'.padStart(6)}`);
  console.log('  ' + '─'.repeat(84));
  for (const r of rows) {
    console.log(`  ${pad(r.keys[0], 52)} ${String(r.clicks).padStart(7)} `
      + `${String(r.impressions).padStart(8)} ${(r.ctr * 100).toFixed(1).padStart(6)}% `
      + `${r.position.toFixed(1).padStart(6)}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────
const [cmd = 'wins', arg] = process.argv.slice(2);
const key = loadKey();
const token = await accessToken(key);

if (cmd === 'sites') {
  const { siteEntry = [] } = await api(token, '/sites');
  console.log(`\nProperties readable by ${key.client_email}:\n`);
  if (!siteEntry.length) {
    console.log('  none — add that email in Search Console → Settings → Users and permissions');
  }
  siteEntry.forEach(s => console.log(`  ${s.siteUrl}   ${s.permissionLevel}`));
  console.log();
  process.exit(0);
}

const site = await resolveSite(token);
const days = Number(arg) || 90;

if (cmd === 'queries') {
  console.log(`\nTop queries — ${site}, last ${days} days\n`);
  table(await search(token, site, { dimension: 'query', days }), 'query');

} else if (cmd === 'pages') {
  console.log(`\nTop pages — ${site}, last ${days} days\n`);
  const rows = await search(token, site, { dimension: 'page', days });
  table(rows.map(r => ({ ...r, keys: [r.keys[0].replace('https://www.beckywexlin.com', '')] })), 'page');

} else if (cmd === 'wins') {
  // Position 8-20 with real impressions: already relevant to Google, just below
  // the fold. Cheapest possible ranking gains — no new content required.
  const rows = await search(token, site, { dimension: 'query', days, limit: 500 });
  const near = rows
    .filter(r => r.position >= 7.5 && r.position <= 20.5 && r.impressions >= 10)
    .sort((a, b) => b.impressions - a.impressions);
  console.log(`\nQueries ranking 8–20 — ${site}, last ${days} days`);
  console.log('Already relevant to Google, just below the fold. Cheapest wins.\n');
  table(near.slice(0, 40), 'query');
  console.log(`\n  ${near.length} such queries, `
    + `${near.reduce((s, r) => s + r.impressions, 0).toLocaleString()} impressions between them.\n`);

} else if (cmd === 'inspect') {
  if (!arg) { console.error('Usage: node scripts/gsc.mjs inspect <url>'); process.exit(1); }
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inspectionUrl: arg, siteUrl: site }),
  });
  const data = await res.json();
  if (data.error) {
    console.error(`${data.error.code}: ${data.error.message}`);
    if (data.error.code === 403) {
      console.error('\nURL Inspection needs Full or Owner permission, not Restricted.');
    }
    process.exit(1);
  }
  const r = data.inspectionResult?.indexStatusResult || {};
  console.log(`\n${arg}`);
  console.log(`  verdict:       ${data.inspectionResult?.indexStatusResult?.verdict}`);
  console.log(`  coverage:      ${r.coverageState}`);
  console.log(`  last crawled:  ${r.lastCrawlTime || 'never'}`);
  console.log(`  canonical:     ${r.googleCanonical || '—'}`);
  console.log(`  robots:        ${r.robotsTxtState}`);
  console.log(`  indexing:      ${r.indexingState}\n`);

} else {
  console.error(`Unknown command "${cmd}". Try: sites | queries | pages | wins | inspect <url>`);
  process.exit(1);
}
