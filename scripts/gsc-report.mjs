#!/usr/bin/env node
/**
 * Search Console + GA4 puller.
 *
 * Replaces the hand-exported CSVs we were working from: organic queries only
 * exist in Search Console, and GA4's API can't report them at all, so both
 * halves are needed to see the whole picture.
 *
 * The service-account key lives OUTSIDE the repo on purpose — the Cloudflare
 * assets directory is the repo root, so anything committed here is downloadable
 * at https://www.beckywexlin.com/<path>.
 *
 *   node scripts/gsc-report.mjs                 last 28 days
 *   node scripts/gsc-report.mjs --days 90
 *   node scripts/gsc-report.mjs --start 2026-05-01 --end 2026-06-01
 *   node scripts/gsc-report.mjs --json          machine-readable
 *   node scripts/gsc-report.mjs --only gsc      skip the GA4 half
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const KEY_PATH = process.env.GSC_KEY || path.join(os.homedir(), '.config/gsc/beckywexlin.json');
// Domain property, not URL-prefix — the string must match exactly or every
// call 403s with "insufficient permission" even when access is granted.
const SITE = process.env.GSC_SITE || 'sc-domain:beckywexlin.com';
// The live property. 532578047 also exists in the GA4 admin but is an empty
// duplicate — querying it returns zeros, which reads as "traffic collapsed".
const GA4_PROPERTY = process.env.GA4_PROPERTY || '532579562';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
].join(' ');

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = { days: 28, json: false, only: 'both', limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--start') a.start = argv[++i];
    else if (k === '--end') a.end = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

const iso = (d) => d.toISOString().slice(0, 10);

function dateRange(a) {
  if (a.start && a.end) return { start: a.start, end: a.end };
  // Search Console lags ~2 days; ending on today would show a false decline.
  const end = new Date(Date.now() - 2 * 86400e3);
  const start = new Date(end.getTime() - (a.days - 1) * 86400e3);
  return { start: iso(start), end: iso(end) };
}

// ---------------------------------------------------------------- auth

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) return cachedToken.value;

  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(
      `No service-account key at ${KEY_PATH}.\n` +
        `Download one from the beckywexlin Google Cloud project and place it there.`
    );
  }
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j));
  cachedToken = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return cachedToken.value;
}

// ---------------------------------------------------------------- api

/** Search Console. `dims` drives the grouping: ['query'], ['page'], ['device']… */
async function searchAnalytics(dims, range, rowLimit, extra = {}) {
  const tok = await accessToken();
  const url =
    'https://searchconsole.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(SITE) +
    '/searchAnalytics/query';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: range.start,
      endDate: range.end,
      dimensions: dims,
      rowLimit,
      // Without this the API silently drops anonymised queries and the totals
      // won't reconcile with the Search Console UI.
      dataState: 'all',
      ...extra,
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`GSC ${dims.join('+')}: ${j.error.message}`);
  return j.rows || [];
}

async function ga4(body) {
  const tok = await accessToken();
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const j = await res.json();
  if (j.error) throw new Error(`GA4: ${j.error.message}`);
  return j;
}

// ---------------------------------------------------------------- output

const num = (n) => Number(n).toLocaleString('en-US');
const pct = (n) => (Number(n) * 100).toFixed(1) + '%';
const pos = (n) => Number(n).toFixed(1);

function table(title, headers, rows) {
  if (!rows.length) {
    console.log(`\n===== ${title} =====\n(no data)`);
    return;
  }
  const all = [headers, ...rows].map((r) => r.map(String));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(`\n===== ${title} =====`);
  console.log(line(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  all.slice(1).forEach((r) => console.log(line(r)));
}

const gscRows = (rows) =>
  rows.map((r) => [
    r.keys.join(' / '),
    num(r.clicks),
    num(r.impressions),
    pct(r.ctr),
    pos(r.position),
  ]);

const GSC_HEAD = ['', 'clicks', 'impr', 'ctr', 'pos'];

// ---------------------------------------------------------------- main

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const range = dateRange(a);
  const out = { site: SITE, range };

  if (a.only !== 'ga4') {
    const [queries, pages, devices, countries] = await Promise.all([
      searchAnalytics(['query'], range, a.limit),
      searchAnalytics(['page'], range, a.limit),
      searchAnalytics(['device'], range, 10),
      searchAnalytics(['country'], range, 10),
    ]);
    Object.assign(out, { queries, pages, devices, countries });

    if (!a.json) {
      console.log(`\nSearch Console — ${SITE}`);
      console.log(`${range.start} to ${range.end}`);
      const totals = devices.reduce(
        (t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }),
        { clicks: 0, impressions: 0 }
      );
      console.log(`totals: ${num(totals.clicks)} clicks, ${num(totals.impressions)} impressions`);
      table(`Top ${a.limit} queries`, GSC_HEAD, gscRows(queries));
      table(`Top ${a.limit} pages`, GSC_HEAD, gscRows(pages));
      table('Device', GSC_HEAD, gscRows(devices));
      table('Country', GSC_HEAD, gscRows(countries));
    }
  }

  if (a.only !== 'gsc') {
    const rep = await ga4({
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'keyEvents' },
        { name: 'totalRevenue' },
      ],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    });
    out.channels = rep.rows || [];
    if (!a.json) {
      table(
        'GA4 sessions by channel',
        ['channel', 'sessions', 'users', 'key events', 'revenue'],
        (rep.rows || []).map((r) => [
          r.dimensionValues[0].value,
          num(r.metricValues[0].value),
          num(r.metricValues[1].value),
          num(r.metricValues[2].value),
          '$' + Number(r.metricValues[3].value).toFixed(2),
        ])
      );
    }
  }

  if (a.json) console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error('\n' + e.message + '\n');
  process.exit(1);
});
