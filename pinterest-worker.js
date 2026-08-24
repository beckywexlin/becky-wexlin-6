/* ============================================
   BECKY WEXLIN CREATIVE — Pinterest scheduled poster
   --------------------------------------------
   A cron-triggered Worker that publishes a few pins a day from
   /pinterest-queue.json and remembers what it has already posted.

   WHY THIS EXISTS, AND WHAT IT DELIBERATELY SKIPS
   Product Pins for every product are already created and kept current by the
   catalog feed at /pinterest-feed.xml. This poster handles only what a feed
   cannot: blog-post pins and secondary product pins on a different image.
   Posting the catalog again here would duplicate it, which Pinterest reads as
   spam.

   PACING IS THE POINT. Pinterest rewards steady publishing far more than
   volume, and dumping 101 pins in one session looks automated. Default is 3
   pins a day, which spreads the queue over about five weeks.

   SETUP
     1. developers.pinterest.com → create an app → note the App ID and secret.
        Scopes needed: boards:read, pins:write (nothing else).
        Add this redirect URI to the app:
          https://<your-worker>.workers.dev/oauth/callback
     2. npx wrangler secret put PINTEREST_APP_ID     --config wrangler.pinterest.jsonc
        npx wrangler secret put PINTEREST_APP_SECRET --config wrangler.pinterest.jsonc
        npx wrangler secret put ADMIN_KEY            --config wrangler.pinterest.jsonc
     3. npx wrangler deploy --config wrangler.pinterest.jsonc
     4. Visit  https://<your-worker>.workers.dev/oauth/start?key=<ADMIN_KEY>
        Authorise once. The worker stores the refresh token itself — no token
        ever gets pasted into a config file or this repo.

   WHY THE OAUTH DANCE INSTEAD OF PASTING A TOKEN
   Pinterest access tokens expire after 30 days. A pasted token would leave the
   poster silently dead a month from now, which is the opposite of hands-off.
   The worker holds a refresh token instead, mints a short-lived access token as
   needed, and rotates the refresh token when Pinterest issues a new one.

   The boards must exist in Pinterest first — the API can create them, but
   board names and descriptions are keyword real estate and are better written
   by hand. This matches queue boards to live boards by name.

   MANUAL RUN / DRY RUN
     GET  https://<worker>/status      what is posted, what is queued
     POST https://<worker>/run?dry=1   preview the next batch, publish nothing
     POST https://<worker>/run         publish the next batch now
   Both require ?key=<ADMIN_KEY> so a stray request can't spend the queue.
   ============================================ */

const QUEUE_URL = 'https://www.beckywexlin.com/pinterest-queue.json';
const PIN_API_PROD = 'https://api.pinterest.com/v5';

// NO SANDBOX MODE. Pinterest's "sandbox" is not isolated — calls to
// api-sandbox.pinterest.com with a sandbox token created real boards and real
// Pins on the live account. A mode labelled safe that isn't is worse than no
// mode at all, so it's gone. Everything here talks to production and is
// treated as permanent.
const PINS_PER_RUN = 3;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const KV_REFRESH = 'oauth:refresh_token';
const KV_ACCESS = 'oauth:access_token';
// Pinterest's create-pin endpoint demands more than the operation implies. A
// token holding exactly boards:read + pins:write is rejected with
//   401 Missing: ['boards:write', 'pins:read']
// which is not what the API reference describes, but is what it returns. The
// minimal set was the right instinct — surplus scopes slow app review and widen
// the blast radius if a token leaks — but it does not work, so the four scopes
// the endpoint actually checks are requested instead.
//
// Changing this string alone changes nothing: scopes are baked into the token
// at authorisation, so an existing token has to be re-authorised through
// /oauth/start before the new set takes effect.
const OAUTH_SCOPES = 'boards:read,boards:write,pins:read,pins:write';

// Access tokens last 30 days; refresh tokens are "continuous" — 60 days, and
// Pinterest may hand back a new one on each exchange, so the new value has to
// be persisted or the chain breaks. The access token is cached in KV with a
// safety margin rather than re-minted on every single API call.
async function accessToken(env) {
  const cached = await env.PIN_STATE.get(KV_ACCESS, { type: 'json' });
  if (cached?.token && cached.expires > Date.now() + 5 * 60_000) return cached.token;

  const refresh = (await env.PIN_STATE.get(KV_REFRESH)) || env.PINTEREST_REFRESH_TOKEN;
  if (!refresh) {
    throw new Error('no refresh token — visit /oauth/start?key=<ADMIN_KEY> to authorise once');
  }

  const basic = btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`);
  const res = await fetch(`${PIN_API_PROD}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`token refresh failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  await env.PIN_STATE.put(KV_ACCESS, JSON.stringify({
    token: body.access_token,
    expires: Date.now() + (Number(body.expires_in) || 2592000) * 1000,
  }));
  // Rotate only when Pinterest actually issues a new refresh token.
  if (body.refresh_token && body.refresh_token !== refresh) {
    await env.PIN_STATE.put(KV_REFRESH, body.refresh_token);
  }
  return body.access_token;
}

async function pinterest(env, path, init = {}) {
  const token = await accessToken(env);
  const res = await fetch(`${PIN_API_PROD}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

// Pinterest paginates boards. Names are matched case-insensitively so a board
// renamed "Funny graphic tees" still lines up with the queue's "Funny Graphic
// Tees".
async function boardMap(env) {
  const map = new Map();
  let bookmark = '';
  for (let page = 0; page < 10; page++) {
    const qs = `?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`;
    const { ok, status, body } = await pinterest(env, `/boards${qs}`);
    if (!ok) throw new Error(`listing boards failed (HTTP ${status}): ${JSON.stringify(body)}`);
    for (const b of body.items || []) map.set(String(b.name || '').trim().toLowerCase(), b.id);
    bookmark = body.bookmark || '';
    if (!bookmark) break;
  }
  return map;
}

async function loadQueue() {
  const res = await fetch(QUEUE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`queue fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.pins) || !data.pins.length) throw new Error('queue is empty');
  return data;
}

const postedKey = id => `posted:${id}`;

async function alreadyPosted(env, ids) {
  // KV has no bulk get, but the queue is ~100 items so this stays cheap.
  const results = await Promise.all(
    ids.map(async id => [id, await env.PIN_STATE.get(postedKey(id))]));
  return new Set(results.filter(([, v]) => v).map(([id]) => id));
}

async function publishBatch(env, { dry = false, limit = PINS_PER_RUN } = {}) {
  const queue = await loadQueue();
  const ids = queue.pins.map(p => p.id);
  const done = await alreadyPosted(env, ids);
  const pending = queue.pins.filter(p => !done.has(p.id));

  if (!pending.length) {
    return { posted: [], skipped: [], remaining: 0,
      note: 'queue exhausted — regenerate with scripts/pinterest-plan.mjs, or leave it; '
          + 'the catalog feed keeps product pins current on its own' };
  }

  const boards = await boardMap(env);

  // Only consider pins whose board actually exists. Taking the first N pending
  // regardless would stall the whole queue: if the frontmost pins belong to a
  // board that hasn't been created, they'd be skipped every single run and
  // nothing would ever post. Filtering first means boards can be created
  // gradually and the poster simply works with whatever is there.
  const postable = pending.filter(p => boards.has(p.board.trim().toLowerCase()));
  const waitingOnBoards = pending.length - postable.length;

  if (!postable.length) {
    return { posted: [], skipped: [], remaining: pending.length, waitingOnBoards,
      note: 'nothing postable — none of the queued pins have a matching Pinterest board yet' };
  }

  // Round-robin across boards so a single run spreads over several boards
  // instead of stacking three pins onto one, which reads as automated.
  const byBoard = new Map();
  for (const p of postable) {
    const k = p.board.trim().toLowerCase();
    if (!byBoard.has(k)) byBoard.set(k, []);
    byBoard.get(k).push(p);
  }
  const batch = [];
  const lists = [...byBoard.values()];
  for (let round = 0; batch.length < limit; round++) {
    let addedThisRound = false;
    for (const list of lists) {
      if (batch.length >= limit) break;
      if (list[round]) { batch.push(list[round]); addedThisRound = true; }
    }
    if (!addedThisRound) break;
  }

  const posted = [];
  const skipped = [];

  for (const pin of batch) {
    const boardId = boards.get(pin.board.trim().toLowerCase());
    if (dry) {
      posted.push({ id: pin.id, board: pin.board, title: pin.title, dryRun: true });
      continue;
    }

    const { ok, status, body } = await pinterest(env, '/pins', {
      method: 'POST',
      body: JSON.stringify({
        board_id: boardId,
        title: pin.title.slice(0, 100),
        description: pin.description.slice(0, 800),
        link: pin.link,
        alt_text: pin.title.slice(0, 500),
        media_source: { source_type: 'image_url', url: pin.image },
      }),
    });

    if (ok) {
      // Mark only after Pinterest confirms, so a failure retries tomorrow
      // rather than silently losing the pin.
      await env.PIN_STATE.put(postedKey(pin.id), new Date().toISOString());
      posted.push({ id: pin.id, board: pin.board, title: pin.title, pinId: body?.id });
    } else {
      skipped.push({ id: pin.id, reason: `HTTP ${status}`, detail: body });
      // 401/403 means the token is dead — stop rather than burning the batch.
      if (status === 401 || status === 403) break;
    }
  }

  return { posted, skipped, waitingOnBoards,
    remaining: pending.length - posted.filter(p => !p.dryRun).length };
}

function authorised(url, env) {
  return env.ADMIN_KEY && url.searchParams.get('key') === env.ADMIN_KEY;
}

export default {
  // Cron entry point. Failures are logged and re-thrown so they surface in
  // `wrangler tail` and Cloudflare's dashboard rather than failing silently.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await publishBatch(env);
        console.log('pinterest cron:', JSON.stringify(result));
      } catch (err) {
        console.error('pinterest cron FAILED:', err.message);
        throw err;
      }
    })());
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    // ── one-time authorisation ──────────────────────────────────────
    // Getting a refresh token normally means running an OAuth handshake by
    // hand with curl. Doing it here instead means the only human step is
    // clicking "Allow", and no token is ever copied into a terminal, a config
    // file, or this repo — where, as of this morning, source was public.
    if (url.pathname === '/oauth/start') {
      if (!authorised(url, env)) return json({ error: 'unauthorised' }, 401);
      const redirect = `${url.origin}/oauth/callback`;
      const auth = new URL('https://www.pinterest.com/oauth/');
      auth.searchParams.set('client_id', env.PINTEREST_APP_ID || '');
      auth.searchParams.set('redirect_uri', redirect);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', OAUTH_SCOPES);
      // Round-trips the admin key so the callback can prove it came from here.
      auth.searchParams.set('state', env.ADMIN_KEY || '');
      return Response.redirect(auth.toString(), 302);
    }

    if (url.pathname === '/oauth/callback') {
      if (url.searchParams.get('state') !== env.ADMIN_KEY) {
        return json({ error: 'state mismatch — start again at /oauth/start' }, 401);
      }
      const code = url.searchParams.get('code');
      if (!code) return json({ error: 'Pinterest returned no code', query: Object.fromEntries(url.searchParams) }, 400);

      const basic = btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`);
      const res = await fetch(`${PIN_API_PROD}/oauth/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${url.origin}/oauth/callback`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.refresh_token) {
        return json({ error: 'token exchange failed', status: res.status, detail: body }, 502);
      }
      await env.PIN_STATE.put(KV_REFRESH, body.refresh_token);
      if (body.access_token) {
        await env.PIN_STATE.put(KV_ACCESS, JSON.stringify({
          token: body.access_token,
          expires: Date.now() + (Number(body.expires_in) || 2592000) * 1000,
        }));
      }
      return new Response(
        'Connected. The poster can now publish to Pinterest and will keep its own '
        + 'token fresh — nothing else to do.\n\nNext: POST /run?key=<ADMIN_KEY>&dry=1 '
        + 'to preview the first batch.',
        { headers: { 'Content-Type': 'text/plain' } });
    }

    // Read-only diagnostic. Uses boards:read, which we already hold. Added to
    // answer one question: did the sandbox /demo runs leak into the real
    // account? The demo names its boards "<board> (API demo <stamp>)", so if
    // any of those show up here, the sandbox was not isolated.
    if (url.pathname === '/boards') {
      if (!authorised(url, env)) return json({ error: 'unauthorised' }, 401);
      try {
        const { ok, status, body } = await pinterest(env, '/boards?page_size=100');
        if (!ok) return json({ error: `HTTP ${status}`, detail: body }, 502);
        const names = (body.items || []).map(b => ({ name: b.name, id: b.id, pins: b.pin_count }));
        return json({
            count: names.length,
          demoBoardsPresent: names.filter(b => /API demo/i.test(b.name)),
          boards: names,
        });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    if (url.pathname === '/status') {
      if (!authorised(url, env)) return json({ error: 'unauthorised' }, 401);
      try {
        const queue = await loadQueue();
        const done = await alreadyPosted(env, queue.pins.map(p => p.id));
        const byBoard = {};
        for (const p of queue.pins) {
          byBoard[p.board] ||= { total: 0, posted: 0 };
          byBoard[p.board].total++;
          if (done.has(p.id)) byBoard[p.board].posted++;
        }
        const hasAuth = !!(await env.PIN_STATE.get(KV_REFRESH)) || !!env.PINTEREST_REFRESH_TOKEN;
        return json({
          authorised: hasAuth || 'NO — visit /oauth/start?key=<ADMIN_KEY>',
          queueGenerated: queue.generated,
          total: queue.pins.length,
          posted: done.size,
          remaining: queue.pins.length - done.size,
          perRun: PINS_PER_RUN,
          byBoard,
        });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    if (url.pathname === '/run' && req.method === 'POST') {
      if (!authorised(url, env)) return json({ error: 'unauthorised' }, 401);
      try {
        return json(await publishBatch(env, { dry: url.searchParams.get('dry') === '1' }));
      } catch (err) { return json({ error: err.message }, 500); }
    }

    return json({ error: 'not found', endpoints: ['/oauth/start?key=', '/status?key=', 'POST /run?key=[&dry=1]', '/boards?key='] }, 404);
  },
};
