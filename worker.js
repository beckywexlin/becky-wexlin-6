const API_BASE = 'https://becky-wexlin-api.beckywexlin.workers.dev';
const SITE = 'https://beckywexlin.com';
const BRAND = 'Becky Wexlin Creative';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/worker.js') {
      return new Response('Not found', { status: 404 });
    }

    if (url.pathname === '/product.html' && url.searchParams.get('id')) {
      return await renderProductPage(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

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

  const htmlRes = await env.ASSETS.fetch(request);
  if (!product || !product.title) return htmlRes;

  const canonical = `${SITE}/product.html?id=${id}`;
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
<script type="application/ld+json" id="product-jsonld">${ldJson}</script>`;

  const rewriter = new HTMLRewriter().on('title', {
    element(el) { el.replace(metaBlock, { html: true }); }
  });

  return rewriter.transform(htmlRes);
}
