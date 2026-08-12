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
const PIN_API_SANDBOX = 'https://api-sandbox.pinterest.com/v5';

// Pinterest's Trial access tier is READ-ONLY — pins:write isn't available, so
// production posting 401s until the app is granted Standard access. Standard
// requires submitting a video of the app calling the API, and Pinterest
// provides the sandbox precisely so that demo can be recorded without write
// access in production.
//
// Set PINTEREST_SANDBOX_TOKEN (from the app dashboard, Environment: Sandbox) to
// route everything at the sandbox. Unset it and the worker is back on
// production with the normal OAuth flow. Nothing about the production path
// changes.
const apiBase = env => (env.PINTEREST_SANDBOX_TOKEN ? PIN_API_SANDBOX : PIN_API_PROD);
const PINS_PER_RUN = 3;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const KV_REFRESH = 'oauth:refresh_token';
const KV_ACCESS = 'oauth:access_token';
// Exactly what the worker uses and nothing more: it lists boards (boards:read)
// and creates pins (pins:write). It never reads existing pins, so pins:read is
// not requested — surplus scopes slow app review and widen the blast radius if
// a token ever leaks.
const OAUTH_SCOPES = 'boards:read,pins:write';

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
  const token = env.PINTEREST_SANDBOX_TOKEN || await accessToken(env);
  const res = await fetch(`${apiBase(env)}${path}`, {
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

    // ── /demo — sandbox only ────────────────────────────────────────
    // Standard access requires a video of the app calling the Pinterest API.
    // The sandbox is a separate environment, so the real boards don't exist
    // there and a normal /run would just report "waiting on missing boards" —
    // a recording of the app doing nothing. This creates the board it needs,
    // then posts one real pin to it, printing both API calls so a reviewer can
    // see the whole exchange.
    //
    // Refuses to run against production: it is a demo, not a posting path.
    if (url.pathname === '/demo' && req.method === 'POST') {
      if (!authorised(url, env)) return json({ error: 'unauthorised' }, 401);
      if (!env.PINTEREST_SANDBOX_TOKEN) {
        return json({ error: 'sandbox only — set PINTEREST_SANDBOX_TOKEN first' }, 400);
      }
      const steps = [];
      try {
        const queue = await loadQueue();
        const pin = queue.pins[0];

        // Sandbox always returns an empty board list even when a name is
        // already taken, so there's no point matching against it — the demo
        // creates its own clearly-labelled board and posts there. Keeps the
        // recording to three clean calls with no error to explain away.
        // Unique per run. Sandbox board names must be unique and the listing
        // endpoint always comes back empty there, so there's no way to detect a
        // previous demo's board — a stamped name is the only thing that reliably
        // gives a clean 201 every time, which is what the recording needs.
        const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
        const demoBoard = `${pin.board} (API demo ${stamp})`;

        steps.push({ step: 1, action: 'GET /boards', note: 'list boards on the authenticated account' });
        const list = await pinterest(env, '/boards?page_size=100');
        steps[0].status = list.status;
        steps[0].boardsFound = (list.body?.items || []).length;

        steps.push({ step: 2, action: 'POST /boards', note: `create "${demoBoard}"` });
        const made = await pinterest(env, '/boards', {
          method: 'POST',
          body: JSON.stringify({ name: demoBoard, description: 'Demo board for Pinterest API review.' }),
        });
        steps[1].status = made.status;
        if (!made.ok) return json({ error: 'could not create board', steps, detail: made.body }, 502);
        const boardId = made.body.id;
        steps[1].boardId = boardId;

        steps.push({ step: 3, action: 'POST /pins', note: `create a Pin on "${demoBoard}"` });
        const created = await pinterest(env, '/pins', {
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
        steps[steps.length - 1].status = created.status;
        steps[steps.length - 1].pinId = created.body?.id;

        return json({
          environment: 'SANDBOX',
          app: 'beckywexlin-poster',
          summary: created.ok
            ? `Created Pin ${created.body?.id} on board "${demoBoard}"`
            : `Pin creation returned HTTP ${created.status}`,
          pin: { title: pin.title, link: pin.link, image: pin.image },
          steps,
          raw: created.body,
        }, created.ok ? 200 : 502);
      } catch (err) {
        return json({ error: err.message, steps }, 500);
      }
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
          environment: env.PINTEREST_SANDBOX_TOKEN ? 'SANDBOX (pins are not real)' : 'production',
          authorised: env.PINTEREST_SANDBOX_TOKEN ? 'n/a — using sandbox token'
            : (hasAuth || 'NO — visit /oauth/start?key=<ADMIN_KEY>'),
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

    return json({ error: 'not found', endpoints: ['/oauth/start?key=', '/status?key=', 'POST /run?key=[&dry=1]', 'POST /demo?key= (sandbox only)'] }, 404);
  },
};
