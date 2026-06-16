const API_BASE = 'https://becky-wexlin-api.beckywexlin.workers.dev';
const SITE = 'https://www.beckywexlin.com';
const BRAND = 'Becky Wexlin Creative';

const CANONICAL_HOST = 'www.beckywexlin.com';
// Every production host that isn't the canonical one 301s to it (kills the
// www/non-www + alt-domain duplicate-content split).
const REDIRECT_HOSTS = new Set(['beckywexlin.com', 'beckyshirts.com', 'www.beckyshirts.com']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (REDIRECT_HOSTS.has(url.hostname)) {
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/worker.js') {
      return new Response('Not found', { status: 404 });
    }

    // Legacy /products/<slug>(.html) → canonical root slug (/<slug>). Done before
    // the generic .html rule so it's a single 301, not a chain.
    if (url.pathname.startsWith('/products/')) {
      const productSlug = url.pathname.replace(/^\/products\//, '').replace(/\.html$/, '');
      if (productSlug && !productSlug.includes('/')) {
        url.pathname = '/' + productSlug;
        return Response.redirect(url.toString(), 301);
      }
    }

    // 301 redirect .html URLs to clean versions (SEO canonicalization)
    if (url.pathname.endsWith('.html')) {
      // /blog/index.html → /blog/
      if (url.pathname.endsWith('/index.html')) {
        url.pathname = url.pathname.replace(/\/index\.html$/, '/');
      } else {
        // /shop.html → /shop, /blog/foo.html → /blog/foo
        url.pathname = url.pathname.replace(/\.html$/, '');
      }
      return Response.redirect(url.toString(), 301);
    }

    // Image proxy — cache Printify images at the edge
    if (url.pathname.startsWith('/img/')) {
      return await proxyImage(url);
    }

    if ((url.pathname === '/product.html' || url.pathname === '/product') && url.searchParams.get('id')) {
      return await renderProductPage(request, env, url);
    }

    // Server-render product grids so crawlers & AI bots see real products
    // (these pages otherwise load their grids client-side from the API).
    if (url.pathname === '/shop') {
      return await renderShop(request, env);
    }
    if (url.pathname.startsWith('/collections/')) {
      return await renderCollection(request, env);
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
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(response.body, { status: response.status, headers });
    }

    // HTML pages: revalidate on every request so updates are seen immediately
    if (ext === 'html' || url.pathname.endsWith('/')) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, no-cache');
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  }
};

async function proxyImage(url) {
  const raw = decodeURIComponent(url.pathname.slice(5)); // strip /img/
  if (!raw.startsWith('https://images-api.printify.com/')) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const imgRes = await fetch(raw, {
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!imgRes.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(imgRes.headers);
    headers.set('Cache-Control', 'public, max-age=2592000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(imgRes.body, { status: 200, headers });
  } catch {
    return new Response('Error', { status: 502 });
  }
}

function slugify(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function resolveSlug(slug) {
  const products = await fetchCatalog();
  const match = products.find(p => p.slug === slug);
  return match ? match.id : null;
}

// Shared, edge-cached catalog fetch used by slug resolution + grid SSR.
async function fetchCatalog() {
  try {
    const r = await fetch(`${API_BASE}/api/products`, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data.products || [];
  } catch { return []; }
}

function htmlResponse(html, srcRes) {
  const headers = new Headers(srcRes.headers);
  headers.set('Cache-Control', 'public, no-cache');
  return new Response(html, { status: srcRes.status, headers });
}

// Product card markup mirroring the client-rendered cards, but linking to the
// canonical root slug. Client JS re-renders identically after load; crawlers
// (which often don't run JS) get real product links/names/images server-side.
function buildCardHTML(p) {
  const rawDesc = String(p.description || '').replace(/<[^>]+>/g, '').trim();
  const desc = rawDesc.length > 90 ? rawDesc.slice(0, 87) + '...' : rawDesc;
  return '<article class="shop-product-card">'
    + `<a href="/${esc(p.slug)}" aria-label="Shop ${esc(p.title)}">`
    + '<div class="shop-card-img">'
    + `<img src="/img/${encodeURIComponent(p.image || '')}" alt="${esc(p.title)}" loading="lazy" onerror="this.src='/images/404.png'" />`
    + '<div class="shop-card-overlay"><span>Shop now &rarr;</span></div>'
    + '</div>'
    + '<div class="shop-card-body">'
    + `<h3 class="shop-card-name">${esc(p.title)}</h3>`
    + `<p class="shop-card-desc">${esc(desc) || 'Fresh from the weird side.'}</p>`
    + '<div class="shop-card-footer">'
    + `<span class="shop-card-price">$${esc(p.price)}</span>`
    + '</div></div></a></article>';
}

async function renderCollection(request, env) {
  const assetRes = await env.ASSETS.fetch(request);
  if (!(assetRes.headers.get('content-type') || '').includes('text/html')) return assetRes;
  const html = await assetRes.text();

  const m = html.match(/COLLECTION_SLUGS\s*=\s*(\[[^\]]*\])/);
  let slugs = [];
  if (m) { try { slugs = JSON.parse(m[1]); } catch {} }
  if (!slugs.length) return htmlResponse(html, assetRes);

  const products = await fetchCatalog();
  const bySlug = new Map(products.map(p => [p.slug, p]));
  const ordered = slugs.map(s => bySlug.get(s)).filter(Boolean);
  if (!ordered.length) return htmlResponse(html, assetRes);

  const cards = ordered.map(buildCardHTML).join('');
  return new HTMLRewriter()
    .on('[id="collection-grid"]', { element(el) { el.setInnerContent(cards, { html: true }); el.setAttribute('style', ''); } })
    .on('[id="collection-loading"]', { element(el) { el.setAttribute('style', 'display:none'); } })
    .transform(htmlResponse(html, assetRes));
}

async function renderShop(request, env) {
  const assetRes = await env.ASSETS.fetch(request);
  if (!(assetRes.headers.get('content-type') || '').includes('text/html')) return assetRes;
  const html = await assetRes.text();

  const products = await fetchCatalog();
  if (!products.length) return htmlResponse(html, assetRes);

  const isSB = p => {
    const title = String(p.title || '').toLowerCase();
    const tags = (p.tags || []).map(t => String(t).toLowerCase());
    return title.includes('santa barbara') || tags.some(t => t.includes('santa barbara'));
  };
  const sb = products.filter(isSB);
  const shirts = products.filter(p => !isSB(p) && !String(p.category || '').includes('hoodie'));
  const hoodies = products.filter(p => String(p.category || '').includes('hoodie'));
  const cardSet = arr => arr.map(buildCardHTML).join('');

  return new HTMLRewriter()
    .on('[id="shirts-grid"]', { element(el) { el.setInnerContent(cardSet(shirts), { html: true }); } })
    .on('[id="shirts"]', { element(el) { if (shirts.length) el.setAttribute('style', ''); } })
    .on('[id="sb-grid"]', { element(el) { el.setInnerContent(cardSet(sb), { html: true }); } })
    .on('[id="santa-barbara"]', { element(el) { if (sb.length) el.setAttribute('style', ''); } })
    .on('[id="hoodies-grid"]', { element(el) { el.setInnerContent(cardSet(hoodies), { html: true }); } })
    .on('[id="hoodies"]', { element(el) { if (hoodies.length) el.setAttribute('style', ''); } })
    .on('[id="shop-loading"]', { element(el) { el.setAttribute('style', 'display:none'); } })
    .transform(htmlResponse(html, assetRes));
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
