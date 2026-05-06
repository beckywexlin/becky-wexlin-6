const API_BASE = 'https://becky-wexlin-api.beckywexlin.workers.dev';
const SITE = 'https://beckywexlin.com';
const BRAND = 'Becky Wexlin Creative';

const CANONICAL_HOST = 'beckywexlin.com';
const ALT_HOSTS = new Set(['beckyshirts.com', 'www.beckyshirts.com']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (ALT_HOSTS.has(url.hostname)) {
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/worker.js') {
      return new Response('Not found', { status: 404 });
    }

    if ((url.pathname === '/product.html' || url.pathname === '/product') && url.searchParams.get('id')) {
      return await renderProductPage(request, env, url);
    }

    const slug = url.pathname.slice(1);
    if (slug && !slug.includes('.') && !slug.includes('/')) {
      const resolved = await resolveSlug(slug);
      if (resolved) {
        url.pathname = '/product.html';
        url.searchParams.set('id', resolved);
        return await renderProductPage(request, env, url);
      }
    }

    const response = await env.ASSETS.fetch(request);
    const ext = url.pathname.split('.').pop();
    const immutable = ['js', 'css', 'woff2', 'woff', 'ttf'];
    const longCache = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'avif'];

    if (immutable.includes(ext) || longCache.includes(ext)) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, max-age=2592000, immutable');
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  }
};

function slugify(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function resolveSlug(slug) {
  try {
    const r = await fetch(`${API_BASE}/api/products`, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const match = (data.products || []).find(p => p.slug === slug);
    return match ? match.id : null;
  } catch { return null; }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderProductPage(request, env, url) {
  const id = url.searchParams.get('id');

  let product = null;
  try {
    const r = await fetch(`${API_BASE}/api/products/${id}`, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (r.ok) product = await r.json();
  } catch {}

  const assetUrl = new URL(request.url);
  assetUrl.pathname = '/product.html';
  assetUrl.search = '';
  const htmlRes = await env.ASSETS.fetch(assetUrl.toString());
  if (!product || !product.title) return htmlRes;

  const slug = slugify(product.title);
  const canonical = `${SITE}/${slug}`;
  const plainDesc = String(product.description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const shortDesc = plainDesc.length > 155 ? plainDesc.slice(0, 152) + '...' : plainDesc;
  const image = (product.images && product.images[0]) || '';
  const variants = product.variants || [];
  const firstAvail = variants.find(v => v.available) || variants[0];
  const price = firstAvail ? String(firstAvail.price) : '';
  const anyAvailable = variants.some(v => v.available);
  const title = `${product.title} — ${BRAND}`;

  const offers = variants.map(v => ({
    '@type': 'Offer',
    sku: String(v.id),
    name: v.title,
    price: String(v.price),
    priceCurrency: 'USD',
    availability: v.available
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
    url: canonical
  }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: plainDesc,
    image: product.images || [],
    sku: String(product.id),
    brand: { '@type': 'Brand', name: BRAND },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: price,
      highPrice: price,
      offerCount: offers.length,
      availability: anyAvailable
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      offers
    }
  };

  const ldJson = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  const metaBlock = `<title>${esc(title)}</title>
<meta name="description" content="${esc(shortDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(product.title)}">
<meta property="og:description" content="${esc(shortDesc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:site_name" content="${esc(BRAND)}">
<meta property="product:price:amount" content="${esc(price)}">
<meta property="product:price:currency" content="USD">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(product.title)}">
<meta name="twitter:description" content="${esc(shortDesc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="product-id" content="${esc(id)}">
<script type="application/ld+json" id="product-jsonld">${ldJson}</script>`;

  const rewriter = new HTMLRewriter().on('title', {
    element(el) { el.replace(metaBlock, { html: true }); }
  });

  return rewriter.transform(htmlRes);
}
