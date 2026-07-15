/* ============================================
   BECKY WEXLIN CREATIVE — In-card image carousel
   Swipe through a product's photos right in the grid (no click / no modal).
   Tap still opens the product page. Images lazy-load as you swipe.
   Enhances every .shop-product-card. Self-contained (injects its own styles).
   ============================================ */
(function () {
  var API = 'https://becky-wexlin-api.beckywexlin.workers.dev';
  function proxy(u) { return u ? '/img/' + encodeURIComponent(u) : ''; }

  /* ── styles ── */
  var css = ''
    + '.shop-card-img{position:relative;}'
    + '.shop-card-img .shop-card-overlay{pointer-events:none;}'
    + '.cg-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:4;width:30px;height:30px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;}'
    + '.cg-prev{left:8px;}.cg-next{right:8px;}'
    + '.shop-card-img:hover .cg-arrow{display:flex;}'
    + '@media (hover:none){.shop-card-img:hover .cg-arrow{display:none;}}'
    + '.cg-count{position:absolute;top:8px;right:8px;z-index:4;background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;padding:3px 8px;border-radius:999px;font-family:var(--font-body,sans-serif);pointer-events:none;}'
    + '.cg-dots{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:5px;align-items:center;z-index:4;background:rgba(0,0,0,.4);padding:5px 8px;border-radius:999px;}'
    + '.cg-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.55);cursor:pointer;border:none;padding:0;flex:0 0 auto;}'
    + '.cg-dot.on{background:#fff;}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ── slug -> full image list ── */
  var bySlug = {};
  function indexList(list) { (list || []).forEach(function (p) { if (p && p.slug) bySlug[p.slug] = p.images || []; }); }
  var ready = (function () {
    try {
      var c = sessionStorage.getItem('bw_gallery');
      if (c) { var arr = JSON.parse(c); arr.forEach(function (p) { bySlug[p.slug] = p.images; }); return Promise.resolve(); }
    } catch (e) {}
    return fetch(API + '/api/products?view=full').then(function (r) { return r.json(); }).then(function (d) {
      var list = (d.products || d).map(function (p) { return { slug: p.slug, images: p.images || [] }; });
      list.forEach(function (p) { bySlug[p.slug] = p.images; });
      try { sessionStorage.setItem('bw_gallery', JSON.stringify(list)); } catch (e) {}
    }).catch(function () {});
  })();

  function enhance(card) {
    if (card.getAttribute('data-cg')) return;
    var wrap = card.querySelector('.shop-card-img');
    var a = card.querySelector('a[href^="/"]');
    var img = wrap && wrap.querySelector('img');
    if (!wrap || !a || !img) return;
    var slug = a.getAttribute('href').replace(/^\//, '').split(/[?#]/)[0];
    var imgs = (bySlug[slug] || []).slice(0, 8); // cap — a 20-photo swipe is tedious and clutters the dots
    card.setAttribute('data-cg', '1');
    if (imgs.length < 2) return; // single photo — nothing to swipe

    var i = 0;

    var prev = document.createElement('button'); prev.type = 'button'; prev.className = 'cg-arrow cg-prev'; prev.setAttribute('aria-label', 'Previous photo'); prev.innerHTML = '&#8249;';
    var next = document.createElement('button'); next.type = 'button'; next.className = 'cg-arrow cg-next'; next.setAttribute('aria-label', 'Next photo'); next.innerHTML = '&#8250;';
    var dots = document.createElement('div'); dots.className = 'cg-dots';
    var count = document.createElement('span'); count.className = 'cg-count';
    wrap.appendChild(prev); wrap.appendChild(next); wrap.appendChild(dots); wrap.appendChild(count);

    function render() {
      dots.innerHTML = imgs.map(function (_, n) { return '<button type="button" class="cg-dot' + (n === i ? ' on' : '') + '" data-n="' + n + '" aria-label="Photo ' + (n + 1) + '"></button>'; }).join('');
      count.textContent = (i + 1) + '/' + imgs.length;
    }
    function go(n, e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      i = (n + imgs.length) % imgs.length;
      img.src = proxy(imgs[i]);
      [i + 1, i - 1].forEach(function (k) { var m = (k + imgs.length) % imgs.length; var pi = new Image(); pi.src = proxy(imgs[m]); });
      render();
    }
    prev.addEventListener('click', function (e) { go(i - 1, e); });
    next.addEventListener('click', function (e) { go(i + 1, e); });
    dots.addEventListener('click', function (e) { var d = e.target.closest('.cg-dot'); if (d) go(+d.dataset.n, e); });

    // touch swipe — distinguish tap (navigate) from swipe (change photo)
    var x0 = 0, y0 = 0, moved = false;
    wrap.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; moved = false; }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      var dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) moved = true;
    }, { passive: true });
    wrap.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - x0;
      if (moved && Math.abs(dx) > 40) go(dx < 0 ? i + 1 : i - 1);
    });
    // block navigation when the gesture was a horizontal swipe
    a.addEventListener('click', function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);

    render();
  }

  function scan() { document.querySelectorAll('.shop-product-card').forEach(enhance); }
  ready.then(scan);
  var root = document.getElementById('main-content') || document.body;
  new MutationObserver(function () { ready.then(scan); }).observe(root, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function () { ready.then(scan); });
})();
