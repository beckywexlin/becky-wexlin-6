const PRINTIFY_BASE = "https://api.printify.com/v1";
const SHOP_ID = "26790889";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function printify(path, env, opts = {}) {
  const res = await fetch(`${PRINTIFY_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.PRINTIFY_API_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

// How long a cached entry is considered "fresh". After this, it's still served
// instantly but refreshed in the background (stale-while-revalidate).
const FRESH_TTL = 300;
// How long caches.default physically retains an entry. Kept long so we always
// have something stale to serve instead of blocking on the slow Printify API.
const STORE_TTL = 86400;
// What we tell the browser/CDN. Short max-age + SWR so the edge re-checks often
// but never makes a user wait on a revalidation.
const CLIENT_CC = 'public, max-age=120, stale-while-revalidate=86400';

// Fetch fresh data, store it long-lived in caches.default, and return a
// browser-facing copy. The ONLY path that blocks on the upstream Printify call.
async function refreshCache(cache, cacheKey, handler, now) {
  const fresh = await handler();
  if (fresh.status !== 200) return fresh;
  const body = await fresh.arrayBuffer();

  const stored = new Response(body, fresh);
  stored.headers.set('Cache-Control', `public, max-age=${STORE_TTL}`);
  stored.headers.set('x-cached-at', String(now));
  await cache.put(cacheKey, stored.clone());

  const client = new Response(body, fresh);
  client.headers.set('Cache-Control', CLIENT_CC);
  client.headers.set('x-cached-at', String(now));
  client.headers.set('x-cache', 'MISS');
  return client;
}

// Serve from cache if present. Fresh hits return immediately; stale hits return
// immediately AND kick off a background refresh. Only a completely empty cache
// (first request ever / post-eviction) waits on the upstream.
async function cachedResponse(cacheKey, handler, ctx) {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  const now = Date.now();

  if (cached) {
    const cachedAt = Number(cached.headers.get('x-cached-at') || 0);
    const ageSec = (now - cachedAt) / 1000;
    if (ageSec >= FRESH_TTL && ctx) {
      // stale — refresh in the background, don't make this user wait
      ctx.waitUntil(refreshCache(cache, cacheKey, handler, now));
    }
    const out = new Response(cached.body, cached);
    out.headers.set('Cache-Control', CLIENT_CC);
    out.headers.set('x-cache', ageSec >= FRESH_TTL ? 'STALE' : 'HIT');
    return out;
  }

  return await refreshCache(cache, cacheKey, handler, now);
}

// Builds the /api/products payload. Shared by the request handler and the cron
// warmer so the cache key and contents stay identical.
async function buildProductsResponse(url, env) {
  // Printify caps each page at 50 products. Fetch EVERY page so products beyond
  // the first 50 aren't silently dropped from the catalog. An explicit ?page=
  // still does a single-page fetch (back-compat / debugging).
  const PAGE_SIZE = 50;
  const explicitPage = url.searchParams.get("page");
  let raw = [];
  let total = null;

  if (explicitPage) {
    const limit = url.searchParams.get("limit") || 50;
    const { status, ok, body } = await printify(
      `/shops/${SHOP_ID}/products.json?page=${explicitPage}&limit=${limit}`, env
    );
    if (!ok) return json({ error: "Printify error", detail: body }, status);
    raw = body.data || body.products || [];
    total = body.total ?? null;
  } else {
    for (let page = 1; page <= 20; page++) {
      const { status, ok, body } = await printify(
        `/shops/${SHOP_ID}/products.json?page=${page}&limit=${PAGE_SIZE}`, env
      );
      if (!ok) {
        if (page === 1) return json({ error: "Printify error", detail: body }, status);
        break; // a later-page failure: serve what we have rather than nothing
      }
      const data = body.data || body.products || [];
      raw = raw.concat(data);
      total = body.total ?? total;
      if (data.length < PAGE_SIZE) break; // last page reached
    }
  }

  const all = raw.filter(p => {
    const hasImage = !!(p.images && p.images.length > 0);
    const hasVariants = (p.variants || []).some(v => v.is_enabled);
    return p.visible && hasImage && hasVariants;
  }).map(normalizeProduct);

  // Default to a SLIM listing payload (~6KB gzip vs ~44KB full). The full
  // response is dominated by data no list/strip consumer reads — top-level
  // `options` (~50%), the full `images` array, the full `variants` array, and
  // long descriptions. We drop those but PRESERVE the field shapes every client
  // reads (images[0], variants[0].price, description) so no client needs edits.
  // Product detail pages get full data from /api/products/:id. ?view=full opts
  // back into the complete list if ever needed.
  if (url.searchParams.get('view') === 'full') {
    return json({ products: all, total: total ?? all.length });
  }
  const products = all.map(slimProduct);
  return json({ products, total: total ?? products.length });
}

function slimProduct(p) {
  const image = p.image ?? (p.images && p.images[0]?.src) ?? null;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    category: p.category,
    tags: p.tags,
    price: p.price,
    image,
    images: image ? [image] : [],
    variants: [{ price: p.price }],
    description: String(p.description || '').slice(0, 200),
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // /debug
    if (pathname === "/debug") {
      const keyPresent = !!env.PRINTIFY_API_KEY;
      const keyLen = env.PRINTIFY_API_KEY?.length ?? 0;
      const shopsRes = await printify("/shops.json", env);
      const prodsRes = await printify(`/shops/${SHOP_ID}/products.json?limit=5`, env);
      return json({
        apiKeyPresent: keyPresent,
        apiKeyLength: keyLen,
        shopsStatus: shopsRes.status,
        productsStatus: prodsRes.status,
        productsRawKeys: prodsRes.ok ? Object.keys(prodsRes.body) : null,
        productsError: prodsRes.ok ? null : prodsRes.body,
        visibleValues: prodsRes.ok
          ? (prodsRes.body.data || []).map(p => ({ title: p.title, visible: p.visible }))
          : null,
      });
    }

    // /debug/catalog — explains the gap between "published in Printify" and
    // "live on the site". Lists every product the shop returns alongside the
    // three flags buildProductsResponse filters on, so a listing that looks
    // published but never appears can be diagnosed instead of guessed at.
    // Read-only and uncached.
    if (pathname === "/debug/catalog") {
      // ?shop= lets us look inside the OTHER connected shops (etsy, tiktok, …)
      // when a product is published somewhere the site never reads.
      const shopId = url.searchParams.get("shop") || SHOP_ID;
      let raw = [];
      for (let page = 1; page <= 20; page++) {
        const { ok, body } = await printify(
          `/shops/${shopId}/products.json?page=${page}&limit=50`, env
        );
        if (!ok) break;
        const data = body.data || body.products || [];
        raw = raw.concat(data);
        if (data.length < 50) break;
      }
      const rows = raw.map(p => ({
        id: p.id,
        title: p.title,
        visible: !!p.visible,
        hasImage: !!(p.images && p.images.length > 0),
        hasEnabledVariants: (p.variants || []).some(v => v.is_enabled),
        variantCount: (p.variants || []).length,
      }));
      const passes = r => r.visible && r.hasImage && r.hasEnabledVariants;
      // The shop list matters here too: the worker reads exactly one SHOP_ID, so
      // a product created in a second connected shop is invisible to the site no
      // matter how published it looks in Printify.
      const shopsRes = await printify("/shops.json", env);
      return json({
        configuredShopId: SHOP_ID,
        shops: shopsRes.ok ? shopsRes.body : null,
        inShop: rows.length,
        onSite: rows.filter(passes).length,
        excluded: rows.filter(r => !passes(r)),
        titles: rows.map(r => r.title),
      });
    }

    // /api/products
    if (pathname === "/api/products") {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      return cachedResponse(cacheKey, () => buildProductsResponse(url, env), ctx);
    }

    // /api/products/:id
    const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      return cachedResponse(cacheKey, async () => {
        const id = productMatch[1];
        const { status, ok, body } = await printify(
          `/shops/${SHOP_ID}/products/${id}.json`, env
        );
        if (!ok) return json({ error: "Product not found", detail: body }, status);
        return json(normalizeProduct(body));
      }, ctx);
    }

    // ── Printify webhook: shipment events ────────────────────────────────
    // Fires when a shipment is created (tracking exists) or delivered. The
    // payload carries no email and no product names — only SKUs — so the order
    // has to be fetched to build anything a customer would want to read.
    if (pathname === "/webhooks/printify" && req.method === "POST") {
      // The signature is over the exact bytes Printify sent, so the raw text has
      // to be read before parsing.
      const raw = await req.text();

      if (env.PRINTIFY_WEBHOOK_SECRET) {
        const ok = await verifyPrintifySignature(raw, req.headers.get('X-Pfy-Signature'), env.PRINTIFY_WEBHOOK_SECRET);
        if (!ok) return json({ error: "bad signature" }, 401);
      }

      let payload;
      try { payload = JSON.parse(raw); }
      catch { return json({ error: "bad json" }, 400); }

      const topic = payload.type || payload.topic || '';
      const SHIPMENT_TOPICS = {
        'order:shipment:created': 'Order Shipped',
        'order:shipment:delivered': 'Order Delivered',
      };
      const metricName = SHIPMENT_TOPICS[topic];

      // Anything else is acknowledged, not an error — Printify retries on a
      // non-2xx, and retrying a topic we don't act on achieves nothing.
      if (!metricName) return json({ received: true, ignored: topic });

      // Printify retries, and a duplicate would send a second "it shipped"
      // email. Klaviyo dedupes on $event_id, so pass its event id straight
      // through rather than inventing one.
      const eventId = payload.id || '';

      // Do the slow part after responding. Printify times these out, and a
      // timeout is recorded as a delivery failure that triggers another retry.
      ctx.waitUntil(handleShipment(payload, topic, metricName, eventId, env));
      return json({ received: true });
    }

    // ── Webhook administration ───────────────────────────────────────────
    // Registering a webhook needs the Printify key, which lives here as a
    // secret. Exposing these behind ADMIN_KEY beats copying the key onto a
    // laptop to run curl once.
    if (pathname === "/admin/webhooks") {
      if (!env.ADMIN_KEY) return json({ error: "ADMIN_KEY not configured" }, 503);
      const given = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
      if (given !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);

      if (req.method === "GET") {
        const r = await printify(`/shops/${SHOP_ID}/webhooks.json`, env);
        return json(r.body, r.ok ? 200 : r.status);
      }

      if (req.method === "POST") {
        const { topic, url: target } = await req.json().catch(() => ({}));
        if (!topic || !target) return json({ error: "topic and url required" }, 400);
        const body = { topic, url: target };
        // Register with the same secret the receiver verifies against, read
        // from the worker's own environment. The value never has to be typed,
        // pasted or transported anywhere to get the two sides matching.
        if (env.PRINTIFY_WEBHOOK_SECRET) body.secret = env.PRINTIFY_WEBHOOK_SECRET;
        const r = await printify(`/shops/${SHOP_ID}/webhooks.json`, env, {
          method: 'POST', body: JSON.stringify(body),
        });
        return json(r.body, r.ok ? 200 : r.status);
      }

      if (req.method === "DELETE") {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: "id required" }, 400);
        const r = await printify(`/shops/${SHOP_ID}/webhooks/${id}.json`, env, { method: 'DELETE' });
        return json(r.body, r.ok ? 200 : r.status);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return json({ error: "Not found" }, 404);
  },

  // Cron warmer — repopulate the catalog cache before it ever goes stale, so no
  // visitor ever triggers the slow (~15s) Printify fetch on the request path.
  async scheduled(event, env, ctx) {
    const url = new URL("https://becky-wexlin-api.beckywexlin.workers.dev/api/products");
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    ctx.waitUntil(
      refreshCache(caches.default, cacheKey, () => buildProductsResponse(url, env), Date.now())
    );
  },
};

// Printify signs the raw body with HMAC-SHA256 and sends the hex digest in
// X-Pfy-Signature, usually prefixed "sha256=". Without the secret set, the
// endpoint is an open door: anyone who guesses the URL could fake a shipment
// and send a customer a bogus tracking email.
async function verifyPrintifySignature(raw, header, secret) {
  if (!header) return false;
  const sent = header.trim().replace(/^sha256=/i, '').toLowerCase();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const want = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (want.length !== sent.length) return false;
  // Constant-time compare — a length-agnostic === leaks the digest byte by byte.
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

async function handleShipment(payload, topic, metricName, eventId, env) {
  const resource = payload.resource || {};
  const data = resource.data || {};
  const orderId = resource.id || '';
  // carrier lives at resource.data.carrier, NOT resource.carrier.
  const carrier = data.carrier || {};
  const shippedSkus = new Set((data.skus || []).map(String));

  if (!orderId) return;

  const orderRes = await printify(`/shops/${SHOP_ID}/orders/${orderId}.json`, env);
  if (!orderRes.ok) return;
  const order = orderRes.body || {};
  const to = order.address_to || {};
  const email = to.email || '';
  if (!email) return;

  // A split shipment only covers some line items, so report what actually
  // shipped. If the SKUs don't line up, fall back to the whole order rather
  // than sending an email with an empty item list.
  const all = order.line_items || [];
  const matched = all.filter(li => shippedSkus.has(String(li.metadata?.sku || '')));
  const items = (matched.length ? matched : all).map(li => ({
    name: li.metadata?.title || '',
    variant: li.metadata?.variant_label || '',
    quantity: li.quantity || 1,
    // Printify prices are integer cents.
    price: ((li.metadata?.price || 0) / 100).toFixed(2),
  }));

  const properties = {
    order_id: orderId,
    carrier: carrier.code || '',
    tracking_number: carrier.tracking_number || '',
    tracking_url: carrier.tracking_url || '',
    shipped_at: data.shipped_at || '',
    partial_shipment: matched.length > 0 && matched.length < all.length,
    items,
  };
  if (eventId) properties.$event_id = eventId;

  await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      revision: '2024-10-15',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: metricName } } },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email,
                first_name: to.first_name || '',
                last_name: to.last_name || '',
              },
            },
          },
          properties,
        },
      },
    }),
  });
}

function stripHtml(html) {
  if (!html) return '';
  // Remove size guide tables entirely
  let clean = html.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, '');
  // Strip all HTML tags
  clean = clean.replace(/<[^>]+>/g, '');
  // Decode common entities
  clean = clean.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

function slugify(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeProduct(p) {
  const enabledVariants = (p.variants || []).filter(v => v.is_enabled);
  const minCents = enabledVariants.length
    ? Math.min(...enabledVariants.map(v => v.price))
    : 0;
  const image = p.images?.[0]?.src ?? null;

  const titleLower = (p.title || '').toLowerCase();
  const tagStr = (p.tags || []).join(' ').toLowerCase();
  const combined = titleLower + ' ' + tagStr;

  let category = 'shirts';
  if (combined.includes('hoodie') || combined.includes('sweatshirt') || combined.includes('crewneck') || combined.includes('pullover')) {
    category = 'hoodies';
  } else if (combined.includes('hat') || combined.includes('cap') || combined.includes('beanie')) {
    category = 'hats';
  } else if (combined.includes('tote') || combined.includes('bag')) {
    category = 'accessories';
  }

  return {
    id:          p.id,
    slug:        slugify(p.title),
    title:       p.title,
    description: stripHtml(p.description),
    image,
    images:      (p.images || []).map(i => ({ src: i.src, variant_ids: i.variant_ids || [] })),
    price:       (minCents / 100).toFixed(2),
    category,
    variants:    enabledVariants.map(v => ({
      id:        v.id,
      title:     v.title,
      price:     (v.price / 100).toFixed(2),
      available: v.is_available ?? true,
      options:   v.options ?? [],
    })),
    options:     p.options ?? [],
    tags:        p.tags ?? [],
  };
}