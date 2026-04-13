# Becky Wexlin Creative

Funky, weird & wonderful apparel. Built with plain HTML/CSS/JS, hosted on GitHub Pages, domain via Cloudflare.

## Project structure

```
becky-wexlin/
├── css/
│   ├── style.css         # Global styles — brand tokens, layout, components
│   └── shop.css          # Product grid styles (to be built)
├── js/
│   └── main.js           # Nav, interactions
├── images/               # Logos, product images, og-image
├── blog/
│   ├── index.html        # Blog listing page
│   └── post-template.html
├── index.html            # Homepage
├── shop.html             # All products
├── about.html            # Brand story
├── contact.html          # Contact + FAQ
├── sitemap.xml           # For Google/search engines
├── robots.txt            # Crawler instructions
└── README.md             # This file
```

## Logo files

Place your logo files in `/images/`:
- `logo-lime.png`           — neon logo, for dark backgrounds (nav, footer)
- `logo-black.png`          — black version, for light backgrounds
- `logo-bw-monogram.png`    — bw retro monogram, use as logo-lime source
- `logo-lime.png`             — 32x32 or 64x64 logo-lime (export from bw monogram)
- `og-image.jpg`            — 1200x630px social share image

## Deploying to GitHub Pages + Cloudflare

1. Push this folder to a GitHub repo (e.g. `becky-wexlin`)
2. Go to repo Settings → Pages → set source to `main` branch, `/ (root)`
3. GitHub gives you a URL like `yourusername.github.io/becky-wexlin`
4. In Cloudflare DNS, add a CNAME record pointing your domain to that URL
5. Add a `CNAME` file in this folder with just your domain name: `beckywexlin.com`

## Adding products

Each product card in `index.html` and `shop.html` has a placeholder `href="shop.html"`.
Replace with your Printify product page URL when ready.

## SEO checklist per new page

- [ ] Unique `<title>` tag (50–60 chars)
- [ ] Unique `<meta name="description">` (120–155 chars)
- [ ] `<link rel="canonical">` pointing to the page URL
- [ ] One `<h1>` per page
- [ ] All images have descriptive `alt` text
- [ ] Add page to `sitemap.xml`
