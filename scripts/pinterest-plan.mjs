#!/usr/bin/env node
/* ============================================================
   Pinterest content pack generator — beckywexlin.com
   ------------------------------------------------------------
   Builds a ready-to-post set of boards and pins from the live catalog and
   the blog, so posting is paste-and-go rather than compose-from-scratch.

   IMPORTANT — what this deliberately does NOT do:
   Product Pins are already created and kept current by the catalog feed at
   /pinterest-feed.xml. Re-posting the same products as fresh pins would
   duplicate them, which Pinterest treats as spam. So the pins generated here
   are the ones the catalog CAN'T make:

     - board definitions (a feed creates pins, never boards)
     - blog-post pins (Article Rich Pins, outside the product catalog)
     - secondary product pins on a DIFFERENT image + angle from the catalog's,
       spread across boards, which is how Pinterest rewards fresh content
       without duplicating a pin

   Output (written to ./pinterest-out/, gitignored):
     boards.md   board names + descriptions, paste straight into Pinterest
     pins.csv    one row per pin — imports into Tailwind / Buffer / Later,
                 or work down it by hand
     pins.md     the same thing, readable

   Usage:  node scripts/pinterest-plan.mjs [--per-board 8]
   ============================================================ */

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.beckywexlin.com';
const API = 'https://becky-wexlin-api.beckywexlin.workers.dev/api/products';
const OUT = join(ROOT, 'pinterest-out');

const argPer = process.argv.indexOf('--per-board');
const PER_BOARD = argPer > -1 ? Number(process.argv[argPer + 1]) || 8 : 8;

// Board names are written the way people SEARCH Pinterest, not the way the
// shop is organised. "Weird Gift Ideas" earns a board; "New Arrivals" wouldn't
// — nobody searches for that.
const BOARDS = [
  { name: 'Funny Graphic Tees', from: 'funny-t-shirts',
    desc: 'Funny graphic tees that are actually funny — deadpan humour, original artwork, printed on premium heavyweight cotton. Weird t-shirts for people who would rather be asked about their outfit than complimented on it. Designed in Santa Barbara, California.' },
  { name: 'Meme Shirts', from: 'meme-t-shirts',
    desc: 'Meme t-shirts built on internet folklore that actually lasts — Harambe, rickrolling, Kilroy, alien disclosure. Original illustration, not screenshots. For people who were online before it was a personality trait.' },
  { name: 'Skull and Skeleton Tees', from: 'skull-t-shirts',
    desc: 'Skull t-shirts and skeleton graphic tees for the morbidly stylish. Memento mori as a design brief — pastel goth, outlaw western, repeat-pattern skulls. Alt and soft grunge outfit ideas on heavyweight cotton.' },
  { name: 'Animal Graphic Tees', from: 'animal-t-shirts',
    desc: 'Animal graphic tees with agendas — cats running the household, dinosaurs making terrible puns, pop-art gorillas. Original illustration, no stock clip art. Funny cat shirts, dog shirts and dinosaur tees for adults.' },
  { name: 'Cowgirl Aesthetic Outfits', from: 'cowboy-t-shirts',
    desc: 'Cowgirl aesthetic and coastal cowboy outfit ideas without the rope font. Skeleton cowboys, pop-art cowgirls, western graphic tees in real colour. How to wear the western look without it reading as costume.' },
  { name: 'Alien and UFO Shirts', from: 'alien-t-shirts',
    desc: 'Alien t-shirts and UFO graphic tees for the disclosure-pilled. The Free the Aliens series — glitchy visitors, typewriter text, trippy bubble letters. Original artwork, not traced clip art.' },
  { name: 'Santa Barbara and the 805', from: 'santa-barbara-t-shirts',
    desc: 'Santa Barbara t-shirts made by an actual local, not a souvenir shop. Cabrillo palms, Goleta the Goodland, Santa Freakin Barbara. California coastal outfit ideas and gifts for anyone who knows the 805.' },
  { name: 'Graphic Tees for Men', from: 'mens-graphic-tees',
    desc: "Men's graphic tees that aren't from a mall — deadpan text, skulls, dinosaurs, meme references. Heavyweight blanks with a real size run. Simple outfit ideas: one loud graphic, everything else plain." },
  { name: 'Graphic Tees for Women', from: 'womens-graphic-tees',
    desc: "Women's graphic tees that aren't about wine or being tired. Pastel goth, pop-art cowgirl, disco glam, retro smiley. Unisex cuts you can size down for a closer fit or wear oversized." },
];

const GIFT_BOARD = {
  name: 'Weird Gift Ideas',
  desc: 'Gift ideas for people who are impossible to shop for. Funny and weird graphic tees under $30 with free shipping — the kind of present that proves you were paying attention rather than panic-buying.',
};
const STYLE_BOARD = {
  name: 'Graphic Tee Outfit Ideas',
  desc: 'How to style weird and funny graphic tees without looking like you are in costume. Fit rules, colour pairing, layering, and what to wear a strange shirt with.',
};

const collectionSlugs = name => {
  const html = readFileSync(join(ROOT, 'collections', `${name}.html`), 'utf8');
  const m = html.match(/COLLECTION_SLUGS\s*=\s*(\[[^\]]*\])/);
  return m ? JSON.parse(m[1]) : [];
};

// Pinterest indexes the description, so it leads with what someone would type
// and only then gets to the joke. Kept under ~500 characters, which is where
// Pinterest truncates in most surfaces.
const pinDesc = (title, board) =>
  `${title} — original ${board.toLowerCase().includes('gift') ? 'graphic tee gift' : 'graphic tee'} `
  + `from Becky Wexlin Creative, an independent studio in Santa Barbara, California. `
  + `Weird, funny, deadpan designs printed on premium heavyweight cotton — Comfort Colors, `
  + `Bella + Canvas and Gildan. Unisex sizing, made to order, free shipping on every order.`;

// The catalog feed pins each product's FRONT image. A second pin must look
// genuinely different or Pinterest sees a duplicate — so this picks a
// lifestyle/worn shot, and refuses to fall back to the front image.
//
// The list endpoint only returns ONE image per product, and it's usually the
// same front shot the feed uses. The full gallery only exists on the detail
// endpoint, so we fetch per product. That's 60-odd requests, which is fine in a
// local script (the Workers subrequest cap doesn't apply here).
const label = u => (/camera_label(?:=|%3D)([a-z0-9-]+)/i.exec(u || '')?.[1] || '').toLowerCase();

function secondaryImage(images) {
  const usable = (images || [])
    .map(i => i.src || i)
    .filter(Boolean)
    .filter(u => !/size[-_]chart/i.test(u) && !/closeup|close-up/i.test(label(u)));
  // Worn shots perform best on Pinterest — they show scale and styling.
  // No `back` fallback: the feed sometimes leads with a back shot too, and two
  // products ended up with a pin identical to their catalog pin. A product with
  // no worn or hanging shot simply gets no secondary pin — its feed pin stands.
  return usable.find(u => /^person/.test(label(u)))
    || usable.find(u => /^(lifestyle|hanging)/.test(label(u)))
    || null;
}

// Fetch full galleries with a small concurrency cap so we don't hammer the API.
async function fetchGalleries(products, concurrency = 8) {
  const out = new Map();
  const queue = [...products];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const r = await fetch(`${API.replace(/\/products$/, '/products')}/${p.id}`);
        if (r.ok) {
          const full = await r.json();
          if (full?.images) out.set(p.slug, full.images);
        }
      } catch { /* skip — product just gets no secondary pin */ }
    }
  }));
  return out;
}

function blogPins() {
  const dir = join(ROOT, 'blog');
  return readdirSync(dir)
    .filter(f => f.endsWith('.html') && !['index.html', 'post-template.html'].includes(f))
    .map(f => {
      const html = readFileSync(join(dir, f), 'utf8');
      const grab = re => (html.match(re) || [, ''])[1]
        .replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’')
        .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–').trim();
      const title = grab(/<title>(.*?)<\/title>/s);
      const desc = grab(/<meta name="description" content="(.*?)"/s);
      const img = grab(/<meta property="og:image" content="(.*?)"/s);
      const slug = f.replace(/\.html$/, '');
      // Style and gift posts belong on the topical boards; the rest are
      // general-interest and sit with the styling content.
      const board = /gift/.test(slug) ? GIFT_BOARD.name : STYLE_BOARD.name;
      return { board, title, description: desc, image: img, link: `${SITE}/blog/${slug}`, kind: 'blog' };
    });
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ── build ────────────────────────────────────────────────────────────────
const res = await fetch(API);
if (!res.ok) { console.error(`catalog fetch failed: HTTP ${res.status}`); process.exit(1); }
const raw = (await res.json()).products || [];

// Same slug dedupe the worker does — two Printify listings share a title.
const seen = new Set();
const products = raw.filter(p => p?.slug && !seen.has(p.slug) && seen.add(p.slug));
const bySlug = new Map(products.map(p => [p.slug, p]));

const galleries = await fetchGalleries(products);
console.log(`fetched ${galleries.size}/${products.length} product galleries`);

const pins = [];
for (const board of BOARDS) {
  const slugs = collectionSlugs(board.from);
  let added = 0;
  for (const slug of slugs) {
    if (added >= PER_BOARD) break;
    const p = bySlug.get(slug);
    if (!p) continue;
    const img = secondaryImage(galleries.get(p.slug));
    if (!img) continue;                       // no alternate angle => the feed pin is enough
    pins.push({
      board: board.name,
      title: p.title.slice(0, 100),
      description: pinDesc(p.title, board.name),
      image: `${SITE}/img/${encodeURIComponent(img)}`,
      link: `${SITE}/${p.slug}`,
      kind: 'product',
    });
    added++;
  }
}

// Gift board pulls the broadest-appeal designs across collections.
const GIFT_PICKS = ['punky-memento-mori-tee', 'bad-ass-tee', 'the-cat-has-spoken-tee',
  't-rexcellent-shirt', 'hot-mess-express-tee', 'dont-worry-be-hoppy',
  'support-your-local-library-shirt', 'santa-barbara-retro-script'];
for (const slug of GIFT_PICKS) {
  const p = bySlug.get(slug);
  if (!p) continue;
  const img = secondaryImage(galleries.get(p.slug));
  if (!img) continue;
  pins.push({
    board: GIFT_BOARD.name,
    title: p.title.slice(0, 100),
    description: pinDesc(p.title, GIFT_BOARD.name),
    image: `${SITE}/img/${encodeURIComponent(img)}`,
    link: `${SITE}/${p.slug}`,
    kind: 'product',
  });
}

pins.push(...blogPins());

// ── write ────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const allBoards = [...BOARDS, GIFT_BOARD, STYLE_BOARD];
writeFileSync(join(OUT, 'boards.md'),
  `# Pinterest boards — ${allBoards.length} to create\n\n`
  + `Create these once. Board names are written the way people search Pinterest,\n`
  + `not the way the shop is organised. Descriptions are keyword real estate —\n`
  + `Pinterest indexes them.\n\n`
  + allBoards.map(b => `## ${b.name}\n\n${b.desc}\n`).join('\n'));

writeFileSync(join(OUT, 'pins.csv'),
  ['Board,Title,Description,Image URL,Destination URL,Type',
   ...pins.map(p => [p.board, p.title, p.description, p.image, p.link, p.kind].map(csvCell).join(','))
  ].join('\n'));

const byBoard = pins.reduce((m, p) => ((m[p.board] ||= []).push(p), m), {});
writeFileSync(join(OUT, 'pins.md'),
  `# Pin queue — ${pins.length} pins\n\n`
  + `Product Pins for all ${products.length} products are already created and kept\n`
  + `current by the catalog feed. These are the pins the feed CAN'T make:\n`
  + `alternate-angle product pins spread across boards, plus the blog posts.\n\n`
  + `Pace them — a few a day beats posting everything at once.\n\n`
  + Object.entries(byBoard).map(([b, list]) =>
      `## ${b}  (${list.length})\n\n` + list.map(p =>
        `- **${p.title}**\n  - image: ${p.image}\n  - link: ${p.link}\n  - ${p.description}\n`
      ).join('\n')).join('\n'));

// Machine-readable queue for the scheduled poster. Written into the repo (not
// pinterest-out/) because pinterest-worker.js fetches it over HTTP — it holds
// only public product data, so serving it costs nothing.
writeFileSync(join(ROOT, 'pinterest-queue.json'), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  boards: allBoards.map(b => ({ name: b.name, description: b.desc })),
  pins: pins.map(p => ({
    board: p.board, title: p.title, description: p.description,
    image: p.image, link: p.link, kind: p.kind,
    // Stable id so the poster can tell what it has already published even if
    // the queue is regenerated and reordered.
    id: `${p.kind}:${p.link.replace(/^https?:\/\//, '')}:${p.board.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  })),
}, null, 2) + '\n');

console.log(`queue  : pinterest-queue.json (${pins.length} pins)`);
console.log(`boards : ${allBoards.length}`);
console.log(`pins   : ${pins.length}  (${pins.filter(p => p.kind === 'product').length} product, ${pins.filter(p => p.kind === 'blog').length} blog)`);
console.log(`written to ${OUT}/  — boards.md, pins.csv, pins.md`);
