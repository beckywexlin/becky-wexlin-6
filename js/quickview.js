/* ============================================
   BECKY WEXLIN CREATIVE — Quick View
   Tap a product's "Quick view" button to preview a large, swipeable
   image gallery + size/color + add to cart, without leaving the grid.
   Self-contained: injects its own styles. Reuses global addToCart().
   ============================================ */
(function () {
  var API = 'https://becky-wexlin-api.beckywexlin.workers.dev';
  function proxy(u) { return u ? '/img/' + encodeURIComponent(u) : ''; }

  /* ── styles ── */
  var css = ''
    + '.qv-btn{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,.8);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:8px 14px;font-family:var(--font-body,sans-serif);font-size:12px;font-weight:600;letter-spacing:.03em;cursor:pointer;z-index:5;opacity:1;transition:background .2s,color .2s,border-color .2s;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);}'
    + '.qv-btn:hover{background:var(--lime,#c8f135);color:#000;border-color:var(--lime,#c8f135);}'
    + '#qv-overlay{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .2s;}'
    + '#qv-overlay.on{opacity:1;pointer-events:all;}'
    + '.qv-modal{background:var(--offblack,#161616);border:1px solid #2a2a2a;border-radius:16px;width:100%;max-width:860px;max-height:90vh;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;position:relative;}'
    + '.qv-close{position:absolute;top:10px;right:12px;z-index:4;background:rgba(0,0,0,.5);border:none;color:#fff;font-size:26px;line-height:1;width:36px;height:36px;border-radius:50%;cursor:pointer;}'
    + '.qv-media{position:relative;background:#1e1e1e;display:flex;align-items:center;justify-content:center;min-height:320px;}'
    + '.qv-img{width:100%;height:100%;max-height:90vh;object-fit:contain;display:block;}'
    + '.qv-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;background:rgba(0,0,0,.5);color:#fff;border:none;width:38px;height:38px;border-radius:50%;font-size:22px;line-height:1;cursor:pointer;}'
    + '.qv-prev{left:8px;}.qv-next{right:8px;}'
    + '.qv-dots{position:absolute;bottom:10px;left:0;right:0;display:flex;gap:6px;justify-content:center;}'
    + '.qv-dot{width:7px;height:7px;border-radius:50%;border:none;background:rgba(255,255,255,.4);cursor:pointer;padding:0;}'
    + '.qv-dot.on{background:var(--lime,#c8f135);}'
    + '.qv-info{padding:28px 26px;overflow-y:auto;display:flex;flex-direction:column;}'
    + '.qv-title{font-family:var(--font-display,Georgia,serif);font-size:24px;font-style:italic;font-weight:900;color:#fff;margin:0 0 8px;line-height:1.1;}'
    + '.qv-price{font-size:18px;color:var(--lime,#c8f135);margin:0 0 12px;}'
    + '.qv-vlabel{font-size:13px;color:#aaa;margin:14px 0 8px;}'
    + '.qv-opts{display:flex;flex-wrap:wrap;gap:8px;}'
    + '.qv-opt{background:#1a1a1a;border:1px solid #333;color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;}'
    + '.qv-opt.on{background:var(--lime,#c8f135);color:#000;border-color:var(--lime,#c8f135);font-weight:600;}'
    + '.qv-opt.off,.qv-opt[disabled]{opacity:.3;cursor:not-allowed;text-decoration:line-through;}'
    + '.qv-add{margin-top:22px;}'
    + '.qv-details{display:inline-block;margin-top:14px;color:#aaa;font-size:13px;text-decoration:underline;text-underline-offset:3px;}'
    + '.qv-loading{color:#777;font-size:14px;}'
    + '.qv-err{color:var(--pink,#ff5da2);font-size:13px;margin:10px 0 0;}'
    + '@media (max-width:700px){.qv-modal{grid-template-columns:1fr;max-height:92vh;overflow-y:auto;}.qv-media{min-height:62vw;}.qv-info{padding:20px;}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ── slug -> product index (id/title/price/image) ── */
  var bySlug = {};
  function index(list) { (list || []).forEach(function (p) { if (p && p.slug) bySlug[p.slug] = p; }); }
  try {
    var cache = sessionStorage.getItem('bw_products_full') || sessionStorage.getItem('bw_products');
    if (cache) index(JSON.parse(cache));
  } catch (e) {}
  function ensureIndex() {
    if (Object.keys(bySlug).length) return Promise.resolve();
    return fetch(API + '/api/products').then(function (r) { return r.json(); })
      .then(function (d) { index(d.products || d); }).catch(function () {});
  }

  /* ── overlay ── */
  var ov = document.createElement('div');
  ov.id = 'qv-overlay';
  ov.innerHTML =
    '<div class="qv-modal" role="dialog" aria-modal="true" aria-label="Product quick view">' +
      '<button class="qv-close" aria-label="Close quick view">&times;</button>' +
      '<div class="qv-media">' +
        '<button class="qv-nav qv-prev" aria-label="Previous image">&#8249;</button>' +
        '<img class="qv-img" id="qv-img" alt="" />' +
        '<button class="qv-nav qv-next" aria-label="Next image">&#8250;</button>' +
        '<div class="qv-dots" id="qv-dots"></div>' +
      '</div>' +
      '<div class="qv-info">' +
        '<h3 class="qv-title" id="qv-title"></h3>' +
        '<p class="qv-price" id="qv-price"></p>' +
        '<div class="qv-vars" id="qv-vars"></div>' +
        '<p class="qv-err" id="qv-err" hidden>Pick a size first.</p>' +
        '<button class="btn btn-primary qv-add" id="qv-add">Add to cart</button>' +
        '<a class="qv-details" id="qv-details" href="#">View full details &rarr;</a>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);

  var imgEl = ov.querySelector('#qv-img'), dotsEl = ov.querySelector('#qv-dots'),
      titleEl = ov.querySelector('#qv-title'), priceEl = ov.querySelector('#qv-price'),
      varsEl = ov.querySelector('#qv-vars'), addBtn = ov.querySelector('#qv-add'),
      errEl = ov.querySelector('#qv-err'), detailsEl = ov.querySelector('#qv-details');

  var imgs = [], idx = 0, prod = null, pick = null;

  function show() {
    if (!imgs.length) { imgEl.removeAttribute('src'); dotsEl.innerHTML = ''; return; }
    idx = (idx + imgs.length) % imgs.length;
    imgEl.src = proxy(imgs[idx]);
    dotsEl.innerHTML = imgs.map(function (_, n) { return '<button class="qv-dot' + (n === idx ? ' on' : '') + '" data-n="' + n + '" aria-label="Image ' + (n + 1) + '"></button>'; }).join('');
  }
  ov.querySelector('.qv-next').onclick = function () { idx++; show(); };
  ov.querySelector('.qv-prev').onclick = function () { idx--; show(); };
  dotsEl.onclick = function (e) { var d = e.target.closest('.qv-dot'); if (d) { idx = +d.dataset.n; show(); } };
  var sx = 0, media = ov.querySelector('.qv-media');
  media.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
  media.addEventListener('touchend', function (e) { var dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) { idx += dx < 0 ? 1 : -1; show(); } });

  function openOv() { ov.classList.add('on'); document.body.style.overflow = 'hidden'; }
  function closeOv() { ov.classList.remove('on'); document.body.style.overflow = ''; }
  ov.querySelector('.qv-close').onclick = closeOv;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeOv(); });
  document.addEventListener('keydown', function (e) {
    if (!ov.classList.contains('on')) return;
    if (e.key === 'Escape') closeOv();
    else if (e.key === 'ArrowRight') { idx++; show(); }
    else if (e.key === 'ArrowLeft') { idx--; show(); }
  });

  /* ── variant selectors ── */
  function colorsOf(p) {
    var out = [];
    (p.variants || []).forEach(function (v) {
      var c = v.title && v.title.indexOf(' / ') > -1 ? v.title.split(' / ')[0] : null;
      if (c && out.indexOf(c) === -1) out.push(c);
    });
    return out;
  }
  function renderVars(p) {
    pick = null; addBtn.disabled = false; errEl.hidden = true;
    var colors = colorsOf(p), multi = colors.length > 1, html = '';
    if (multi) {
      html += '<p class="qv-vlabel">Color</p><div class="qv-opts" id="qv-colors">' +
        colors.map(function (c, n) { return '<button class="qv-opt' + (n === 0 ? ' on' : '') + '" data-c="' + c + '">' + c + '</button>'; }).join('') + '</div>';
    }
    html += '<p class="qv-vlabel">Size</p><div class="qv-opts" id="qv-sizes"></div>';
    varsEl.innerHTML = html;
    renderSizes(p, multi ? colors[0] : null);
    if (multi) {
      varsEl.querySelector('#qv-colors').onclick = function (e) {
        var b = e.target.closest('.qv-opt'); if (!b) return;
        varsEl.querySelectorAll('#qv-colors .qv-opt').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        renderSizes(p, b.dataset.c);
      };
    }
  }
  function renderSizes(p, color) {
    var list = (p.variants || []).filter(function (v) { return !color || (v.title && v.title.split(' / ')[0] === color); });
    var el = varsEl.querySelector('#qv-sizes');
    el.innerHTML = list.map(function (v) {
      var lbl = v.title && v.title.indexOf(' / ') > -1 ? v.title.split(' / ')[1] : v.title;
      var un = v.available === false;
      return '<button class="qv-opt' + (un ? ' off' : '') + '" data-v="' + v.id + '" data-p="' + v.price + '" data-s="' + (lbl || '') + '"' + (un ? ' disabled' : '') + '>' + (lbl || v.title || '') + '</button>';
    }).join('');
    el.onclick = function (e) {
      var b = e.target.closest('.qv-opt'); if (!b || b.disabled) return;
      el.querySelectorAll('.qv-opt').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      pick = { variantId: +b.dataset.v, price: b.dataset.p, size: b.dataset.s };
      priceEl.textContent = '$' + b.dataset.p; errEl.hidden = true;
    };
    var f = el.querySelector('.qv-opt:not([disabled])'); if (f) f.click();
  }

  addBtn.onclick = function () {
    if (!prod || !pick) { errEl.hidden = false; return; }
    if (typeof addToCart === 'function') {
      addToCart({ id: prod.id, variantId: pick.variantId, title: prod.title, size: pick.size, price: pick.price, image: (imgs[0] || prod.image || ''), quantity: 1 });
      closeOv();
    } else {
      location.href = '/' + prod.slug;
    }
  };

  function openFor(slug) {
    var seed = bySlug[slug];
    openOv();
    titleEl.textContent = seed ? seed.title : '';
    priceEl.textContent = seed && seed.price ? '$' + seed.price : '';
    imgs = seed && seed.image ? [seed.image] : []; idx = 0; show();
    detailsEl.href = '/' + slug; prod = null; pick = null; errEl.hidden = true;
    varsEl.innerHTML = '<p class="qv-loading">Loading options&hellip;</p>';
    if (!seed || !seed.id) {
      varsEl.innerHTML = '<a class="btn btn-primary" href="/' + slug + '">View product &rarr;</a>';
      addBtn.style.display = 'none';
      return;
    }
    addBtn.style.display = ''; addBtn.disabled = true;
    fetch(API + '/api/products/' + seed.id).then(function (r) { return r.json(); }).then(function (full) {
      prod = full;
      if (full.images && full.images.length) { imgs = full.images; idx = 0; show(); }
      titleEl.textContent = full.title || titleEl.textContent;
      renderVars(full);
      addBtn.disabled = false;
    }).catch(function () {
      varsEl.innerHTML = '<a class="btn btn-primary" href="/' + slug + '">View product &rarr;</a>';
      addBtn.style.display = 'none';
    });
  }

  /* ── enhance product cards with a Quick view button ── */
  function enhance(card) {
    if (card.getAttribute('data-qv')) return;
    var a = card.querySelector('a[href^="/"]'), wrap = card.querySelector('.shop-card-img');
    if (!a || !wrap) return;
    var slug = a.getAttribute('href').replace(/^\//, '').split(/[?#]/)[0];
    if (!slug || slug.indexOf('/') > -1) return;
    card.setAttribute('data-qv', '1');
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'qv-btn'; b.setAttribute('aria-label', 'Quick view');
    b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Quick view</span>';
    b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); ensureIndex().then(function () { openFor(slug); }); };
    wrap.appendChild(b);
  }
  function scan() { document.querySelectorAll('.shop-product-card').forEach(enhance); }
  scan();
  var root = document.getElementById('main-content') || document.body;
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
})();
