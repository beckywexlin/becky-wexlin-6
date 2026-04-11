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

export default {
  async fetch(req, env) {
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
      const page  = url.searchParams.get("page")  || 1;
      const limit = url.searchParams.get("limit") || 20;
      const { status, ok, body } = await printify(
        `/shops/${SHOP_ID}/products.json?page=${page}&limit=${limit}`, env
      );
      if (!ok) return json({ error: "Printify error", detail: body }, status);
      const products = (body.data || body.products || []).filter(p => {
  const hasImage = !!(p.images && p.images.length > 0);
  const hasVariants = (p.variants || []).some(v => v.is_enabled);
  return p.visible && hasImage && hasVariants;
}).map(normalizeProduct);
      return json({ products, total: body.total ?? products.length });
    }

    // /api/products/:id
    const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      const id = productMatch[1];
      const { status, ok, body } = await printify(
        `/shops/${SHOP_ID}/products/${id}.json`, env
      );
      if (!ok) return json({ error: "Product not found", detail: body }, status);
      return json(normalizeProduct(body));
    }

    return json({ error: "Not found" }, 404);
  },
};

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
    title:       p.title,
    description: p.description,
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