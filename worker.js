const API_BASE = 'https://becky-wexlin-api.beckywexlin.workers.dev';
const SITE = 'https://www.beckywexlin.com';
const BRAND = 'Becky Wexlin Creative';

// Per-slug SEO title/description overrides. Injects the keywords people actually
// search into the <title>/meta Google reads, WITHOUT changing the Printify title
// (which would change the slug and break the ranking URL). Keyed by canonical slug.
const SEO_OVERRIDES = {
  'dicks-out-for-harambe': {
    title: 'Dicks Out for Harambe Shirt',
    description: 'The "Dicks Out for Harambe" shirt — a meme graphic tee for people who never let it go. Soft cotton, bold print, free shipping.'
  }
};

// ---------------------------------------------------------------------------
// SITEMAP
// /sitemap.xml is generated per-request instead of being a checked-in file, so
// newly published products appear without anyone regenerating anything. Sources:
//   - static pages + collections: the two lists below (they change rarely)
//   - blog posts: scraped from /blog/index.html, so adding a post card is enough
//   - products: the live catalog, which the API already filters to `visible`
// If the catalog fetch fails we fall back to the checked-in sitemap.xml asset
// rather than serving a sitemap that's missing every product.
const SITEMAP_PAGES = [
  { path: '/',                      changefreq: 'weekly',  priority: '1.0' },
  { path: '/shop',                  changefreq: 'daily',   priority: '0.9' },
  { path: '/collections/',          changefreq: 'weekly',  priority: '0.8' },
  { path: '/blog/',                 changefreq: 'weekly',  priority: '0.8' },
  { path: '/shirts',                changefreq: 'monthly', priority: '0.8' },
  { path: '/santa-barbara-shirts',  changefreq: 'weekly',  priority: '0.8' },
  { path: '/about',                 changefreq: 'monthly', priority: '0.8' },
  { path: '/faq',                   changefreq: 'monthly', priority: '0.8' },
  { path: '/size-guide',            changefreq: 'monthly', priority: '0.8' },
  { path: '/care-guide',            changefreq: 'monthly', priority: '0.7' },
  { path: '/identity',              changefreq: 'monthly', priority: '0.6' },
  { path: '/contact',               changefreq: 'monthly', priority: '0.5' },
  { path: '/shipping',              changefreq: 'yearly',  priority: '0.4' },
  { path: '/refunds',               changefreq: 'yearly',  priority: '0.4' },
];

const SITEMAP_COLLECTIONS = [
  'graphic-tees', 'funny-t-shirts', 'skull-t-shirts',
  'animal-t-shirts', 'santa-barbara-t-shirts', 'meme-t-shirts',
  'mens-graphic-tees', 'womens-graphic-tees', 'alien-t-shirts', 'cowboy-t-shirts',
];

// Known publish dates. A post missing from this map still gets listed — it just
// omits <lastmod>, which is better than emitting a date we made up.
const BLOG_LASTMOD = {
  'how-to-care-for-printed-graphic-tees': '2025-01-15',
  'what-makes-a-quality-graphic-tee':     '2025-01-22',
  'history-of-the-graphic-tee':           '2025-02-01',
  'best-weird-shirts-to-give-as-gifts':   '2025-02-10',
  'why-meme-shirts-are-having-a-moment':  '2025-02-20',
  'how-to-spot-a-well-made-graphic-tee':  '2025-03-01',
  'best-weird-graphic-tee-brands':        '2025-05-01',
  'why-are-graphic-tees-so-expensive-now':'2026-05-09',
  'how-to-style-a-graphic-tee-with-jeans':'2026-05-09',
  'best-graphic-tee-gifts-2026':          '2026-06-01',
  'comfort-colors-vs-bella-canvas':       '2026-06-01',
  'how-to-start-a-graphic-tee-brand':     '2026-06-01',
  'in-defense-of-the-aggressive-pun':     '2026-06-01',
  'y2k-graphic-tees-are-back':            '2026-06-24',
  'cowgirl-aesthetic-outfits':            '2026-06-24',
  'alien-ufo-graphic-tees':               '2026-06-24',
  'sites-like-snorg-tees':                '2026-07-29',
  'science-of-funny-t-shirts':            '2026-08-03',
  't-shirt-dyes-skin-irritation':         '2026-08-03',
  'enclothed-cognition-what-you-wear':    '2026-08-03',
  'best-meme-t-shirts':                   '2026-08-10',
  'how-to-style-weird-graphic-tees':      '2026-08-10',
  'best-santa-barbara-shirts':            '2026-08-10',
};

const CANONICAL_HOST = 'www.beckywexlin.com';
// Every production host that isn't the canonical one 301s to it (kills the
// www/non-www + alt-domain duplicate-content split).
const REDIRECT_HOSTS = new Set(['beckywexlin.com', 'beckyshirts.com', 'www.beckyshirts.com']);

// Product URLs are slugified from the Printify title, so renaming a listing
// silently moves its URL and strands the old one on a 404 — losing whatever it
// had ranked for, plus any external link pointing at it. Retired slugs are
// mapped to their current home here and 301'd.
//
// ADD AN ENTRY EVERY TIME A PRODUCT IS RENAMED IN PRINTIFY. Nothing detects
// this automatically — the API only ever reports current titles, so a rename
// that isn't recorded here is unrecoverable once the old slug is forgotten.
const RETIRED_SLUGS = new Map([
  // Renamed Aug 2026: "Retro Palm Trees Sunset Hoodie | Vintage Vaporwave
  // Beach Graphic" → "Santa Barbara Retro Palm Trees Hoodie"
  ['retro-palm-trees-sunset-hoodie-vintage-vaporwave-beach-graphic', 'santa-barbara-retro-palm-trees-hoodie'],
]);

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
        // Resolve a rename here too, so a legacy URL for a renamed product is
        // still a single 301 rather than a /products/old → /old → /new chain.
        url.pathname = '/' + (RETIRED_SLUGS.get(productSlug) || productSlug);
        return Response.redirect(url.toString(), 301);
      }
    }

    // Renamed product → its current slug.
    const retired = RETIRED_SLUGS.get(url.pathname.slice(1));
    if (retired) {
      url.pathname = '/' + retired;
      return Response.redirect(url.toString(), 301);
    }

    // Trailing slash on a non-directory path was falling through to the asset
    // handler, which answered with a 307. Temporary redirects don't consolidate
    // link equity and Google keeps re-crawling both forms — make it a 301.
    if (url.pathname.length > 1 && url.pathname.endsWith('/')
        && url.pathname !== '/blog/' && url.pathname !== '/collections/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
      return Response.redirect(url.toString(), 301);
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

    // Generated from the live catalog so new products are never missing.
    if (url.pathname === '/sitemap.xml') {
      return await renderSitemap(request, env);
    }

    // Google Merchant Center product feed (free Shopping listings).
    if (url.pathname === '/feed.xml') {
      return await renderMerchantFeed(url);
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
      const headers = securityHeaders(new Headers(response.headers));
      headers.set('Cache-Control', 'public, no-cache');
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  }
};

// --- Sitemap -----------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function sitemapUrl({ path, lastmod, changefreq, priority }) {
  const parts = [`<loc>${xmlEscape(SITE + path)}</loc>`];
  if (lastmod) parts.push(`<lastmod>${lastmod}</lastmod>`);
  if (changefreq) parts.push(`<changefreq>${changefreq}</changefreq>`);
  if (priority) parts.push(`<priority>${priority}</priority>`);
  return `  <url>${parts.join('')}</url>`;
}

// Blog posts are discovered from the blog index, so publishing a post (which
// already means adding its card there) is all that's needed to get it listed.
async function blogSlugsFromIndex(env, origin) {
  try {
    const res = await env.ASSETS.fetch(new URL('/blog/index.html', origin).toString());
    if (!res.ok) return [];
    const html = await res.text();
    const slugs = new Set();
    for (const m of html.matchAll(/href="\/blog\/([a-z0-9][a-z0-9-]*)"/g)) slugs.add(m[1]);
    return [...slugs];
  } catch {
    return [];
  }
}

async function renderSitemap(request, env) {
  const origin = new URL(request.url).origin;

  let products = [];
  try {
    const r = await fetch(`${API_BASE}/api/products`, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (r.ok) {
      const data = await r.json();
      products = (data.products || data || []).filter(p => p && p.slug);
    }
  } catch { /* fall through to the static asset below */ }

  // No catalog => serve the checked-in sitemap rather than one with zero products.
  if (!products.length) {
    return await env.ASSETS.fetch(new URL('/sitemap.xml', origin).toString());
  }

  const seen = new Set();
  const entries = [];
  const add = (e) => {
    if (seen.has(e.path)) return;
    seen.add(e.path);
    entries.push(e);
  };

  for (const p of SITEMAP_PAGES) add(p);

  for (const c of SITEMAP_COLLECTIONS) {
    add({ path: `/collections/${c}`, changefreq: 'weekly', priority: '0.8' });
  }

  for (const slug of await blogSlugsFromIndex(env, origin)) {
    add({
      path: `/blog/${slug}`,
      lastmod: BLOG_LASTMOD[slug],
      changefreq: 'monthly',
      priority: '0.7',
    });
  }

  for (const p of products) {
    add({ path: `/${p.slug}`, changefreq: 'weekly', priority: '0.8' });
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(sitemapUrl).join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// --- Google Merchant Center feed ---------------------------------------------
//
// RSS 2.0 + the Google namespace, generated from the live catalog so a new
// product appears in Shopping without anyone exporting anything.
//
// Apparel is the strictest category Google has: items targeting the US are
// disapproved without color, size, age_group and gender, and every size/colour
// combination has to be its own <item> tied together by item_group_id. The
// catalog LIST endpoint only returns `{price}` per variant, so the real variant
// data has to come from one detail fetch per product.
//
// That's the reason for chunking. Workers allow 50 subrequests per request on
// the free plan, so a 63-product catalog can't be done in one pass. CHUNK_SIZE
// keeps each response under the ceiling; Merchant Center is happy to pull
// several feed URLs, which is normal for larger catalogs anyway.
const CHUNK_SIZE = 40;
const FEED_CATEGORY = 'Apparel & Accessories > Clothing > Shirts & Tops';

// Feed values go inside XML elements, so the five predefined entities are the
// whole job — but unescaped control characters will also break a feed parse.
function feedEsc(s) {
  return xmlEscape(String(s ?? '')).replace(/[ --]/g, '');
}

function plainText(s, max) {
  const t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// The Printify copy carries a supplier-facing tail — a disclaimer naming other
// print providers, and ".:" spec markers that render as line noise in a
// Shopping listing. Neither belongs in front of a shopper.
function feedDescription(raw, title) {
  let s = String(raw || '').replace(/<[^>]+>/g, ' ');
  s = s.split(/Disclaimer\s*:/i)[0];
  s = s.replace(/\s*\.:\s*/g, ' • ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[•\s]+$/, '').trim();
  return plainText(s, 5000)
    || `${title} — an original graphic tee designed by ${BRAND} in Santa Barbara, California.`;
}

// Printify ships a size-chart mockup in the images array. Google treats charts
// and other non-product graphics as promotional and disapproves items for them,
// so it never goes in the feed.
function isProductPhoto(u) {
  return !/size[-_]chart/i.test(String(u || ''));
}

// Printify returns mockups in whatever order the product was configured, so the
// first image is sometimes a folded shirt or a back view. Google judges the
// main image on whether the product is clearly visible, and a folded tee hides
// the graphic that is the entire product. Rank front-facing shots first — this
// only reorders, so every mockup still ships as an additional image.
function imageRank(u) {
  const m = /camera_label(?:=|%3D)([a-z0-9-]+)/i.exec(String(u || ''));
  const label = (m ? m[1] : '').toLowerCase();
  // Checked before the front- prefix: "front-collar-closeup" is a front shot
  // that shows none of the design, which is exactly what Google penalises.
  if (label.includes('closeup') || label.includes('close-up')) return 8;
  if (label === 'front') return 0;
  if (label.startsWith('front')) return 1;
  if (label.startsWith('person')) return 2;
  if (!label) return 3;                       // unlabelled: usually the primary mockup
  if (label.startsWith('hanging')) return 4;
  if (label.startsWith('back')) return 5;
  if (label.startsWith('folded')) return 6;   // hides the graphic entirely
  return 7;
}

function feedItem(product, variant, slug) {
  const title = String(product.title || '').trim();
  const vTitle = String(variant.title || '').trim();
  const hasColor = vTitle.includes(' / ');
  const color = hasColor ? vTitle.split(' / ')[0].trim() : '';
  const size = (hasColor ? vTitle.split(' / ')[1] : vTitle).trim();

  // Google truncates titles at 150 characters. Several Printify titles are long
  // enough that appending the variant would blow the limit, so trim the name
  // rather than the variant — the variant is what distinguishes the item.
  const suffix = [color, size].filter(Boolean).join(', ');
  const room = 150 - (suffix ? suffix.length + 3 : 0);
  const fullTitle = suffix
    ? `${title.length > room ? title.slice(0, room - 1).trimEnd() + '…' : title} - ${suffix}`
    : plainText(title, 150);

  const url = `${SITE}/${slug}`;
  const imgs = (product.images || []).map(i => i.src || i)
    .filter(Boolean).filter(isProductPhoto)
    .map((u, i) => ({ u, i }))
    .sort((a, b) => imageRank(a.u) - imageRank(b.u) || a.i - b.i)
    .map(x => x.u);
  const proxied = u => `${SITE}/img/${encodeURIComponent(u)}`;

  const desc = feedDescription(product.description, title);

  const parts = [
    // Printify variant ids are blueprint-level — a given blank in a given
    // colour and size carries the same id across every product printed on it.
    // Google needs g:id globally unique or items silently overwrite each other,
    // so scope it to the product.
    `<g:id>${feedEsc(product.id)}-${feedEsc(variant.id)}</g:id>`,
    `<g:item_group_id>${feedEsc(product.id)}</g:item_group_id>`,
    `<title>${feedEsc(fullTitle)}</title>`,
    `<description>${feedEsc(desc)}</description>`,
    `<link>${feedEsc(url)}</link>`,
    imgs[0] ? `<g:image_link>${feedEsc(proxied(imgs[0]))}</g:image_link>` : '',
    // Up to 10 extra images allowed; more just get ignored.
    ...imgs.slice(1, 11).map(i => `<g:additional_image_link>${feedEsc(proxied(i))}</g:additional_image_link>`),
    `<g:availability>${variant.available ? 'in_stock' : 'out_of_stock'}</g:availability>`,
    `<g:price>${feedEsc(Number(variant.price).toFixed(2))} USD</g:price>`,
    `<g:brand>${feedEsc(BRAND)}</g:brand>`,
    `<g:condition>new</g:condition>`,
    // Print-on-demand originals carry no GTIN or manufacturer part number.
    // Saying so explicitly is what stops Google demanding one.
    `<g:identifier_exists>no</g:identifier_exists>`,
    `<g:google_product_category>${feedEsc(FEED_CATEGORY)}</g:google_product_category>`,
    `<g:product_type>Apparel &gt; T-Shirts &gt; Graphic Tees</g:product_type>`,
    color ? `<g:color>${feedEsc(color)}</g:color>` : '',
    size ? `<g:size>${feedEsc(size)}</g:size>` : '',
    `<g:size_type>regular</g:size_type>`,
    `<g:size_system>US</g:size_system>`,
    `<g:age_group>adult</g:age_group>`,
    `<g:gender>unisex</g:gender>`,
    `<g:material>Cotton</g:material>`,
    `<g:shipping><g:country>US</g:country><g:service>Standard</g:service>`
      + `<g:price>0.00 USD</g:price></g:shipping>`,
    `<g:shipping_label>free-shipping</g:shipping_label>`,
  ].filter(Boolean);

  return `<item>${parts.join('')}</item>`;
}

async function renderMerchantFeed(url) {
  const chunk = Math.max(0, parseInt(url.searchParams.get('chunk') || '0', 10) || 0);

  const catalog = await fetchCatalog();
  if (!catalog.length) {
    return new Response('Catalog unavailable', { status: 503 });
  }

  const chunks = Math.ceil(catalog.length / CHUNK_SIZE);
  const slice = catalog.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);

  // One detail fetch per product — the only place variant title, size, colour
  // and stock state exist. Edge-cached so Merchant Center's daily pull almost
  // never hits the origin API.
  const detailed = await Promise.all(slice.map(async p => {
    try {
      const r = await fetch(`${API_BASE}/api/products/${p.id}`, {
        // 15 min, not an hour: a price or stock change should reach Merchant
        // Center on the next fetch, not the one after.
        cf: { cacheTtl: 900, cacheEverything: true }
      });
      if (!r.ok) return null;
      const full = await r.json();
      return full && full.title ? { full, slug: p.slug } : null;
    } catch { return null; }
  }));

  const items = [];
  let skipped = 0;
  for (const d of detailed) {
    if (!d) { skipped++; continue; }
    const { full, slug } = d;
    for (const v of full.variants || []) {
      // A variant with no price can't be a valid offer.
      if (v && v.id != null && v.price != null) items.push(feedItem(full, v, slug));
    }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>${xmlEscape(BRAND)}</title>
<link>${SITE}</link>
<description>Original weird, funny and meme graphic tees designed in Santa Barbara, California.</description>
<!-- chunk ${chunk + 1} of ${chunks} | ${slice.length} products | ${items.length} variant items${skipped ? ` | ${skipped} products unavailable` : ''} -->
${items.join('\n')}
</channel>
</rss>
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Merchant Center pulls once a day, so a long edge cache saves nothing —
      // but it WOULD make a manual "Fetch now" return yesterday's catalog right
      // after adding a product. Ten minutes is enough to absorb retries.
      'Cache-Control': 'public, max-age=600',
      'X-Feed-Chunk': `${chunk + 1}/${chunks}`,
      'X-Feed-Items': String(items.length),
    },
  });
}

// Printify-controlled image hosts we'll proxy. Printify migrated most mockups
// from images-api.printify.com to its production S3 mockup buckets, so we must
// allow those too or the extra gallery views 403 (broken images).
const PRINTIFY_CDN_HOST = 'd123s6f1z9g2wk.cloudfront.net';

function isAllowedImageHost(rawUrl) {
  let host;
  try { host = new URL(rawUrl).hostname; } catch { return false; }
  if (host === 'images-api.printify.com' || host === 'images.printify.com') return true;
  // Printify prod mockup media S3 buckets (region may vary), e.g.
  // pfy-prod-products-mockup-media.s3.us-east-2.amazonaws.com
  if (/^pfy-prod-[a-z0-9-]+\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)) return true;
  // Printify's CloudFront distribution, which now serves the uploaded design
  // files (/files/...) that appear in a product's images array. Pinned to the
  // one distribution on purpose — allowing *.cloudfront.net would turn this
  // into an open image proxy for a large chunk of the internet.
  if (host === PRINTIFY_CDN_HOST) return true;
  return false;
}

async function proxyImage(url) {
  const raw = decodeURIComponent(url.pathname.slice(5)); // strip /img/
  if (!isAllowedImageHost(raw)) {
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
//
// Slugs come from the Printify title, so two listings with the same title
// collapse to one URL. When that happens only the first is reachable — the
// second has no URL at all — but both were still rendering a card on /shop and
// both would have been emitted to the product feed. Dedupe on the way in so
// every consumer agrees on one product per slug, and keep the FIRST, which is
// the one resolveSlug() serves.
//
// This is a workaround, not a fix. The real fix is renaming one of the
// duplicates in Printify; until then the second listing is invisible.
async function fetchCatalog() {
  try {
    const r = await fetch(`${API_BASE}/api/products`, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) return [];
    const data = await r.json();
    const seen = new Set();
    return (data.products || []).filter(p => {
      if (!p || !p.slug || seen.has(p.slug)) return false;
      seen.add(p.slug);
      return true;
    });
  } catch { return []; }
}

// Applied to every HTML response. HSTS is the one with SEO weight — it removes
// the http→https hop entirely for repeat visitors, which is latency Googlebot
// pays too.
function securityHeaders(headers) {
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return headers;
}

function htmlResponse(html, srcRes) {
  const headers = securityHeaders(new Headers(srcRes.headers));
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
    // Intrinsic dimensions are required or the grid reflows as each mockup
    // loads — 66 of 68 images on /shop had none, which is pure CLS.
    + `<img src="/img/${encodeURIComponent(p.image || '')}" alt="${esc(p.title)} — graphic tee by ${esc(BRAND)}" width="600" height="600" loading="lazy" decoding="async" onerror="this.src='/images/404.png'" />`
    + '<div class="shop-card-overlay"><span>Shop now &rarr;</span></div>'
    + '</div>'
    + '<div class="shop-card-body">'
    + `<h3 class="shop-card-name">${esc(p.title)}</h3>`
    + `<p class="shop-card-desc">${esc(desc) || 'Fresh from the weird side.'}</p>`
    + '<div class="shop-card-footer">'
    + `<span class="shop-card-price">$${esc(p.price)}</span>`
    + '</div></div></a></article>';
}

// ItemList tells Google — and AI shopping answers — that a page is a list of
// specific, priced products rather than a wall of images. Quince and most
// serious retailers ship it on every category page; it was the single biggest
// schema gap between our collection pages and theirs. Built from the same
// server-side product list that renders the grid, so the two can't disagree.
function itemListScript(products, pageUrl, name) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${pageUrl}#products`,
    name,
    url: pageUrl,
    numberOfItems: products.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: p.title,
      url: `${SITE}/${p.slug}`,
      item: {
        '@type': 'Product',
        name: p.title,
        url: `${SITE}/${p.slug}`,
        ...(p.image ? { image: p.image } : {}),
        brand: { '@type': 'Brand', name: BRAND },
        offers: {
          '@type': 'Offer',
          price: String(p.price),
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url: `${SITE}/${p.slug}`
        }
      }
    }))
  };
  const json = JSON.stringify(ld).replace(/</g, '\\u003c');
  return `<script type="application/ld+json" id="itemlist-jsonld">${json}</script>`;
}

// The page's own <title> is the most accurate name for its ItemList — it
// already carries the category keywords we're targeting.
function pageTitleOf(html, fallback) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].replace(/&amp;/g, '&').trim() : fallback;
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
  const pageUrl = SITE + new URL(request.url).pathname.replace(/\/$/, '');
  const listLd = itemListScript(ordered, pageUrl, pageTitleOf(html, 'Collection'));
  return new HTMLRewriter()
    .on('[id="collection-grid"]', { element(el) { el.setInnerContent(cards, { html: true }); el.setAttribute('style', ''); } })
    .on('[id="collection-loading"]', { element(el) { el.setAttribute('style', 'display:none'); } })
    .on('head', { element(el) { el.append(listLd, { html: true }); } })
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
  const listLd = itemListScript(
    [...shirts, ...sb, ...hoodies], `${SITE}/shop`, pageTitleOf(html, 'Shop'));

  return new HTMLRewriter()
    .on('head', { element(el) { el.append(listLd, { html: true }); } })
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

// Printify descriptions arrive as one dense blob with glued sentences and
// inline "Product features" headings. This mirrors formatDescription() in
// product.html closely enough that the server copy and the client copy read
// the same — tags are stripped first, so nothing from the API can inject HTML.
function formatDescriptionSSR(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  s = s.replace(/([a-z0-9)\]”"'])\.([A-Z])/g, '$1.\n\n$2');
  s = s.replace(/\s*(Product features|Care instructions|Features|Materials|Size & Fit|Size and Fit|Shipping)\b/g, '\n\n$1\n');
  s = s.replace(/(^|\s)-\s+/g, '\n• ');
  s = s.replace(/\s*[✔✓]\s*/g, '\n✔ ');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s.split(/\n\n+/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.length > 1 && lines.every(l => /^[•✔]\s/.test(l))) {
      return '<ul class="desc-list">'
        + lines.map(l => `<li>${esc(l.replace(/^[•✔]\s*/, ''))}</li>`).join('')
        + '</ul>';
    }
    if (lines.length === 1 && lines[0].length < 32 && !/[.!?]$/.test(lines[0])) {
      return `<h3 class="desc-heading">${esc(lines[0])}</h3>`;
    }
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('');
}

const SIZE_ORDER_SSR = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];

// Variant titles are "Color / Size", or just "Size" on single-colour products.
function splitVariants(variants) {
  const pool = variants.filter(v => v.available).length
    ? variants.filter(v => v.available)
    : variants;
  // The list endpoint returns leaner variant objects than the detail endpoint,
  // so never assume `title` is present.
  const titleOf = v => String((v && v.title) || '');
  const colors = [...new Set(pool.map(v =>
    titleOf(v).includes(' / ') ? titleOf(v).split(' / ')[0].trim() : null).filter(Boolean))];
  const sizes = [...new Set(pool.map(v => {
    const t = titleOf(v);
    return (t.includes(' / ') ? t.split(' / ')[1] : t).trim();
  }).filter(Boolean))];
  const rank = s => (SIZE_ORDER_SSR.indexOf(s) === -1 ? 99 : SIZE_ORDER_SSR.indexOf(s));
  sizes.sort((a, b) => rank(a) - rank(b));
  const prices = pool.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
  return {
    colors, sizes,
    lo: prices.length ? Math.min(...prices) : null,
    hi: prices.length ? Math.max(...prices) : null
  };
}

// A real, crawlable version of the product page. loadProduct() replaces this
// with the interactive build once JS runs, so users get the gallery and
// variant pickers while crawlers and AI bots — which mostly don't execute JS —
// get an H1, price, description, sizes and colours instead of "Loading...".
function buildProductSSR(product, canonical) {
  const variants = product.variants || [];
  const { colors, sizes, lo, hi } = splitVariants(variants);
  const img = (product.images && product.images[0] && product.images[0].src) || '';
  const priceLabel = lo == null ? '' : (hi > lo
    ? `$${lo.toFixed(2)} – $${hi.toFixed(2)}`
    : `$${lo.toFixed(2)}`);

  return `<nav aria-label="Breadcrumb" class="pd-breadcrumb">`
    + `<a href="/">Home</a> <span>/</span> <a href="/shop">Shop</a> <span>/</span> `
    + `<span>${esc(product.title)}</span></nav>
<div class="product-layout">
  <div class="product-images">
    ${img ? `<div class="product-main-img"><img src="/img/${encodeURIComponent(img)}" alt="${esc(product.title)} — graphic tee by Becky Wexlin Creative" width="800" height="800" fetchpriority="high" /></div>` : ''}
  </div>
  <div class="product-info">
    <a href="/shop" class="product-back">Back to shop</a>
    <h1 class="product-title">${esc(product.title)}</h1>
    <p class="product-price-large">${esc(priceLabel)}</p>
    <h2 class="pd-desc-label">What makes this design unique</h2>
    <div class="product-description">${formatDescriptionSSR(product.description)}</div>
    ${sizes.length ? `<p class="pd-variant-line"><strong>Sizes:</strong> ${esc(sizes.join(', '))} — <a href="/size-guide">size guide</a></p>` : ''}
    ${colors.length ? `<p class="pd-variant-line"><strong>Colours:</strong> ${esc(colors.join(', '))}</p>` : ''}
    <p class="pd-variant-line"><a class="btn btn-primary" href="${esc(canonical)}">Choose a size &amp; add to cart</a></p>
    <div class="product-meta">
      <p>&#10003; Free shipping on all orders</p>
      <p>&#10003; Made to order, just for you</p>
      <p>&#10003; Wrong or damaged? We&rsquo;ll make it right within 14 days</p>
    </div>
  </div>
</div>`;
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
  const seo = SEO_OVERRIDES[slug] || {};
  const canonical = `${SITE}/${slug}`;
  const plainDesc = String(product.description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const shortDesc = seo.description
    ? seo.description
    : (plainDesc.length > 155 ? plainDesc.slice(0, 152) + '...' : plainDesc);
  const image = (product.images && product.images[0]?.src) || '';
  const variants = product.variants || [];
  const firstAvail = variants.find(v => v.available) || variants[0];
  const price = firstAvail ? String(firstAvail.price) : '';
  const anyAvailable = variants.some(v => v.available);
  const title = `${seo.title || product.title} — ${BRAND}`;

  // Google's merchant listing rich results treat free shipping and a stated
  // return window as strongly-recommended fields — without them the listing is
  // eligible but loses the "Free delivery"/"Free returns" annotations that
  // competitors' listings carry.
  const SHIPPING_DETAILS = {
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: '0', currency: 'USD' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime',
      handlingTime: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 5, unitCode: 'DAY' },
      transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 5, unitCode: 'DAY' }
    }
  };

  // Made-to-order, so we don't restock returns — but misprints and damage are
  // replaced within 14 days. Modelled honestly rather than claiming free returns.
  const RETURN_POLICY = {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'US',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 14,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/FreeReturn'
  };

  const { colors: vColors, sizes: vSizes, lo: vLo, hi: vHi } = splitVariants(variants);

  const offers = variants.map(v => ({
    '@type': 'Offer',
    sku: String(v.id),
    name: v.title,
    price: String(v.price),
    priceCurrency: 'USD',
    itemCondition: 'https://schema.org/NewCondition',
    availability: v.available
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
    url: canonical,
    shippingDetails: SHIPPING_DETAILS,
    hasMerchantReturnPolicy: RETURN_POLICY
  }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${canonical}#product`,
    name: product.title,
    description: plainDesc,
    image: (product.images || []).map(i => i.src || i),
    url: canonical,
    sku: String(product.id),
    mpn: String(product.id),
    brand: { '@type': 'Brand', name: BRAND },
    manufacturer: { '@type': 'Organization', name: 'Becky Wexlin LLC' },
    category: 'Apparel > T-Shirts > Graphic Tees',
    material: 'Cotton',
    audience: { '@type': 'PeopleAudience', suggestedGender: 'unisex' },
    ...(vColors.length ? { color: vColors } : {}),
    ...(vSizes.length ? { size: vSizes } : {}),
    ...(vSizes.length ? {
      hasMeasurement: {
        '@type': 'QuantitativeValue',
        name: 'Available sizes',
        value: vSizes.join(', ')
      }
    } : {}),
    isRelatedTo: { '@type': 'WebPage', name: 'Size guide', url: `${SITE}/size-guide` },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: vLo != null ? vLo.toFixed(2) : price,
      highPrice: vHi != null ? vHi.toFixed(2) : price,
      offerCount: offers.length,
      availability: anyAvailable
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      offers
    }
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Shop', item: `${SITE}/shop` },
      { '@type': 'ListItem', position: 3, name: product.title, item: canonical }
    ]
  };

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url: canonical,
    mainEntity: PRODUCT_FAQ.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a }
    }))
  };

  const ld = obj => JSON.stringify(obj).replace(/</g, '\\u003c');
  const ldJson = ld(jsonLd);

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
<script type="application/ld+json" id="product-jsonld">${ldJson}</script>
<script type="application/ld+json" id="breadcrumb-jsonld">${ld(breadcrumbLd)}</script>
<script type="application/ld+json" id="faq-jsonld">${ld(faqLd)}</script>`;

  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) { el.replace(metaBlock, { html: true }); }
    })
    // The template ships placeholder Product + BreadcrumbList schemas so the
    // page is still valid if the catalog fetch fails. Now that we've emitted
    // the real ones, drop the placeholders — two competing Product blocks on
    // one page is worse than none.
    .on('script[id="product-schema"]', { element(el) { el.remove(); } })
    .on('script[id="breadcrumb-schema"]', { element(el) { el.remove(); } })
    // Stamp the product name into the static buyer-intent copy so that section
    // reads correctly for crawlers that never execute fillProductDetails().
    .on('[data-pd="name"]', {
      element(el) { el.setInnerContent(esc(product.title), { html: true }); }
    })
    // Server-render the product itself. Without this the page ships an empty
    // "Loading..." div and every non-JS crawler — which is most AI crawlers —
    // sees a page with no H1, no product name and no description.
    .on('[id="product-page"]', {
      element(el) { el.setInnerContent(buildProductSSR(product, canonical), { html: true }); }
    });

  return rewriter.transform(htmlRes);
}

// Mirrors the visible FAQ in product.html's #product-detail section verbatim —
// FAQPage markup is only valid when the same Q&A is on the page, so these two
// must be edited together.
const PRODUCT_FAQ = [
  ['What size should I order?',
   'Order your usual size for a standard fit, or go up one for the relaxed, slightly oversized drape most people want from a graphic tee. Every blank we use publishes real chest and body-length measurements — compare them against a shirt you already like on the size guide rather than guessing from a letter.'],
  ['How long will it take to arrive?',
   'This tee is printed to order, so allow roughly 2–5 business days for production plus 3–5 business days for delivery inside the United States. Shipping is free on every order with no minimum, and tracking is emailed as soon as the parcel leaves the print facility.'],
  ['Will the print crack or fade?',
   'Not if you keep it out of high heat. We print direct-to-garment, so the ink bonds into the cotton fibres rather than sitting on the surface as a plastic transfer. Wash cold and inside out, hang dry or tumble on low, and the graphic will outlast the trend that inspired it.'],
  ["Can I return it if it doesn't fit?",
   "Because each shirt is made to order we can't restock returns, but anything that arrives damaged, misprinted or not what you ordered is replaced or refunded within 14 days — just email hello@beckywexlin.com with a photo. Checking the size guide before ordering is the single best way to avoid the problem."],
  ['Is this a real independent brand?',
   'Yes. Becky Wexlin Creative is a one-studio independent apparel label based in Santa Barbara, California. Every graphic is drawn in-house, and orders fund a person with strange ideas rather than a warehouse algorithm. More on that in the story.'],
];
