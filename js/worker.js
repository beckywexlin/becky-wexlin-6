const PRINTIFY_BASE = "https://api.printify.com/v1";
const SHOP_ID = "26790889";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
  const page  = url.searchParams.get("page")  || 1;
  const limit = url.searchParams.get("limit") || 50;
  const { status, ok, body } = await printify(
    `/shops/${SHOP_ID}/products.json?page=${page}&limit=${limit}`, env
  );
  if (!ok) return json({ error: "Printify error", detail: body }, status);
  const all = (body.data || body.products || []).filter(p => {
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
    return json({ products: all, total: body.total ?? all.length });
  }
  const products = all.map(slimProduct);
  return json({ products, total: body.total ?? products.length });
}

function slimProduct(p) {
  const image = p.image ?? (p.images && p.images[0]) ?? null;
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

    // Printify webhook — shipment events
    if (pathname === "/webhooks/printify" && req.method === "POST") {
      try {
        const payload = await req.json();
        const topic = payload.topic || payload.type || '';

        if (topic === 'order:shipment:delivered' || topic === 'order:shipment:ready') {
          const shipment = payload.resource || payload;
          const orderId = shipment.order_id || shipment.id || '';
          const tracking = shipment.carrier?.tracking_number || shipment.tracking?.number || '';
          const carrier = shipment.carrier?.name || shipment.tracking?.carrier || '';
          const trackingUrl = shipment.carrier?.tracking_url || shipment.tracking?.url || '';
          const items = shipment.line_items || shipment.items || [];

          // Look up the original order to get the customer email
          let email = shipment.address?.email || '';
          if (!email && orderId) {
            const orderRes = await printify(`/shops/${SHOP_ID}/orders/${orderId}.json`, env);
            if (orderRes.ok) {
              email = orderRes.body.address_to?.email || '';
            }
          }

          if (email) {
            // Send "Order Shipped" event to Klaviyo
            const klaviyoPayload = {
              data: {
                type: 'event',
                attributes: {
                  metric: { data: { type: 'metric', attributes: { name: 'Order Shipped' } } },
                  profile: { data: { type: 'profile', attributes: { email } } },
                  properties: {
                    order_id: orderId,
                    tracking_number: tracking,
                    carrier,
                    tracking_url: trackingUrl,
                    items: items.map(i => ({
                      name: i.title || i.name || '',
                      quantity: i.quantity || 1,
                    })),
                  },
                },
              },
            };

            await fetch('https://a.klaviyo.com/api/events', {
              method: 'POST',
              headers: {
                'Authorization': `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
                'Content-Type': 'application/json',
                'revision': '2024-10-15',
              },
              body: JSON.stringify(klaviyoPayload),
            });
          }
        }

        return json({ received: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
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
    images:      (p.images || []).map(i => i.src),
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