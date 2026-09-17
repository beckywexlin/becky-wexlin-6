#!/usr/bin/env node
/* ============================================================
   GA4 reader — beckywexlin.com
   ------------------------------------------------------------
   The claude.ai GA4 connector is authorised against a DIFFERENT
   Google Analytics account (German Auto Repair) and cannot see this
   property at all. Rather than depend on it, this reads GA4 directly
   with the same service-account key the Search Console scripts use.

   The key lives OUTSIDE this repo on purpose. The Cloudflare assets
   directory is the repo root, so anything here that isn't in
   .assetsignore is downloadable from the live site. (scripts/ is
   listed, but a credential still has no business in a deployed repo.)

   Usage:
     node scripts/ga4.mjs funnel [days]     view -> cart -> checkout -> buy
     node scripts/ga4.mjs events [days]     event counts, most frequent first
     node scripts/ga4.mjs pages  [days]     landing pages by sessions
     node scripts/ga4.mjs sources [days]    traffic by channel
     node scripts/ga4.mjs realtime          active users right now

   Days defaults to 28. Override the key with GSC_KEY=/path/to.json
   and the property with GA4_PROPERTY=<id>.

   Note on the funnel: add_payment_info is NOT instrumented on this
   site, so it always reads zero. That is a tracking gap, not a step
   where everybody drops — don't read it as a cliff.
   ============================================================ */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_PATH = process.env.GSC_KEY || join(homedir(), '.config/gsc/beckywexlin.json');
// 532578047 also exists in the GA4 admin but is an empty duplicate — querying
// it returns zeros, which reads as "traffic collapsed".
const PROPERTY = process.env.GA4_PROPERTY || '532579562';

const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cached = null;
async function accessToken() {
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.value;
  const key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64(signer.sign(key.private_key))}`;
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
  cached = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.value;
}

async function ga(method, body) {
  const tok = await accessToken();
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:${method}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await res.json();
  if (j.error) throw new Error(`GA4 ${method}: ${j.error.message}`);
  return j;
}

const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const num = (s) => Number(s || 0).toLocaleString();
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

function table(rows, headers, widths) {
  console.log(headers.map((h, i) => (i ? rpad(h, widths[i]) : pad(h, widths[i]))).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(r.map((c, i) => (i ? rpad(c, widths[i]) : pad(c, widths[i]))).join('  '));
  }
}

// ---------------------------------------------------------------- commands

async function funnel(days) {
  // Ordered because a funnel read out of order is worse than no funnel.
  const STEPS = [
    ['session_start', 'Sessions'],
    ['view_item', 'Viewed a product'],
    ['add_to_cart', 'Added to cart'],
    ['begin_checkout', 'Started checkout'],
    ['add_payment_info', 'Entered payment*'],
    ['purchase', 'Purchased'],
  ];
  const j = await ga('runReport', {
    dateRanges: [{ startDate: ago(days), endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: STEPS.map((s) => s[0]).concat('checkout_error') },
      },
    },
  });
  const by = {};
  for (const r of j.rows || []) by[r.dimensionValues[0].value] = r.metricValues;

  console.log(`\nFunnel — last ${days} days (property ${PROPERTY})\n`);
  const rows = [];
  let prev = null;
  for (const [ev, label] of STEPS) {
    const users = Number(by[ev]?.[1].value || 0);
    // Percentages only make sense against the step above, and only when that
    // step actually has users — otherwise every row reads "0%" or "Infinity".
    const drop = prev == null || prev === 0 || (ev === 'add_payment_info' && users === 0)
      ? ''
      : Math.round((users / prev) * 100) + '%';
    rows.push([label, num(by[ev]?.[0].value || 0), num(users), drop]);
    if (ev !== 'add_payment_info') prev = users;
  }
  table(rows, ['step', 'events', 'users', 'of prev'], [20, 9, 9, 8]);
  const errs = Number(by.checkout_error?.[0].value || 0);
  console.log(`\ncheckout_error events: ${errs}${errs === 0 ? '  (checkout itself is not throwing)' : '  <-- investigate'}`);
  console.log('* add_payment_info is not instrumented on this site; it always reads zero.');
}

async function events(days) {
  const j = await ga('runReport', {
    dateRanges: [{ startDate: ago(days), endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 30,
  });
  console.log(`\nEvents — last ${days} days\n`);
  table(
    (j.rows || []).map((r) => [r.dimensionValues[0].value, num(r.metricValues[0].value), num(r.metricValues[1].value)]),
    ['event', 'count', 'users'], [34, 9, 9],
  );
}

async function pages(days) {
  const j = await ga('runReport', {
    dateRanges: [{ startDate: ago(days), endDate: 'today' }],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 25,
  });
  console.log(`\nLanding pages — last ${days} days\n`);
  table(
    (j.rows || []).map((r) => [
      r.dimensionValues[0].value.slice(0, 46),
      num(r.metricValues[0].value),
      num(r.metricValues[1].value),
      Math.round(Number(r.metricValues[2].value)) + 's',
    ]),
    ['landing page', 'sessions', 'users', 'avg'], [46, 9, 7, 7],
  );
}

async function sources(days) {
  const j = await ga('runReport', {
    dateRanges: [{ startDate: ago(days), endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });
  console.log(`\nChannels — last ${days} days\n`);
  table(
    (j.rows || []).map((r) => [
      r.dimensionValues[0].value,
      num(r.metricValues[0].value),
      num(r.metricValues[1].value),
      Math.round(Number(r.metricValues[2].value) * 100) + '%',
    ]),
    ['channel', 'sessions', 'users', 'engaged'], [22, 9, 7, 8],
  );
}

async function realtime() {
  const j = await ga('runRealtimeReport', {
    dimensions: [{ name: 'unifiedScreenName' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 20,
  });
  const rows = j.rows || [];
  console.log('\nActive right now\n');
  if (!rows.length) return console.log('  nobody on the site');
  table(rows.map((r) => [r.dimensionValues[0].value.slice(0, 50), r.metricValues[0].value]),
    ['page', 'users'], [50, 6]);
}

// ---------------------------------------------------------------- main

const [cmd = 'funnel', daysArg] = process.argv.slice(2);
const days = Number(daysArg) || 28;
const commands = { funnel, events, pages, sources, realtime };

if (!commands[cmd]) {
  console.error(`unknown command "${cmd}" — try: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
try {
  await commands[cmd](days);
  console.log('');
} catch (e) {
  console.error('\n' + e.message);
  process.exit(1);
}
