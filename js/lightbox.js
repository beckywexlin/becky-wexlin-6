/* ── IMAGE LIGHTBOX ──
   Product mockups are served at 1200x1200 but displayed at 800px, and only
   420px on mobile — so the detail that sells a shirt (the print texture, the
   small type in a design) was never actually visible. Clicking now opens the
   full-resolution file.

   Deliberately NOT applied to images inside a link: shop cards, collection
   tiles, the strip and the logos all navigate somewhere, and hijacking those
   clicks would break browsing. The `closest('a')` check below is what enforces
   that, so a new linked thumbnail anywhere on the site is safe by default.

   Everything is delegated from document because the product gallery is rebuilt
   in JS whenever a colour is chosen — directly bound handlers would be lost on
   the first colour change. */
(function () {
  var SELECTORS = '.product-main-img img, .post-content img';

  var overlay, imgEl, capEl, prevBtn, nextBtn, counter;
  var group = [];
  var index = 0;
  var lastFocus = null;

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'bw-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Enlarged image');
    overlay.innerHTML =
      '<button class="bw-lb-close" aria-label="Close">&times;</button>' +
      '<button class="bw-lb-nav bw-lb-prev" aria-label="Previous image">&#8592;</button>' +
      '<figure class="bw-lb-figure">' +
        '<img class="bw-lb-img" alt="" />' +
        '<figcaption class="bw-lb-cap"></figcaption>' +
      '</figure>' +
      '<button class="bw-lb-nav bw-lb-next" aria-label="Next image">&#8594;</button>' +
      '<div class="bw-lb-count" aria-hidden="true"></div>';
    document.body.appendChild(overlay);

    imgEl = overlay.querySelector('.bw-lb-img');
    capEl = overlay.querySelector('.bw-lb-cap');
    prevBtn = overlay.querySelector('.bw-lb-prev');
    nextBtn = overlay.querySelector('.bw-lb-next');
    counter = overlay.querySelector('.bw-lb-count');

    overlay.querySelector('.bw-lb-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    // Click the backdrop to dismiss, but not the picture itself.
    // The picture carries a zoom-out cursor, so clicking it has to close —
    // promising one thing and doing another is worse than no affordance.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay
          || e.target.classList.contains('bw-lb-figure')
          || e.target === imgEl) close();
    });
  }

  /* The gallery a click belongs to. On a product page the thumbnails hold the
     images for the CURRENT colour, which is the set worth paging through; the
     main image alone would strand someone on one view. */
  function galleryFor(el) {
    if (el.closest('.product-main-img')) {
      var thumbs = document.querySelectorAll('.product-thumbs img');
      if (thumbs.length > 1) return Array.prototype.slice.call(thumbs);
    }
    var post = el.closest('.post-content');
    if (post) {
      return Array.prototype.slice.call(post.querySelectorAll('img'));
    }
    return [el];
  }

  /* <picture> serves a webp/jpeg pair; currentSrc is what the browser actually
     chose, which beats guessing from the srcset. */
  function bestSrc(el) {
    return el.currentSrc || el.src;
  }

  function show(i) {
    if (!group.length) return;
    index = (i + group.length) % group.length;
    var src = group[index];
    imgEl.src = src.src;
    imgEl.alt = src.alt || '';
    capEl.textContent = src.alt || '';
    capEl.style.display = src.alt ? '' : 'none';
    var many = group.length > 1;
    prevBtn.style.display = many ? '' : 'none';
    nextBtn.style.display = many ? '' : 'none';
    counter.style.display = many ? '' : 'none';
    counter.textContent = (index + 1) + ' / ' + group.length;
  }

  function step(d) { show(index + d); }

  function open(el) {
    build();
    var nodes = galleryFor(el);
    group = nodes.map(function (n) { return { src: bestSrc(n), alt: n.alt || '' }; });
    var here = bestSrc(el);
    var start = group.findIndex(function (g) { return g.src === here; });
    lastFocus = document.activeElement;
    show(start > -1 ? start : 0);
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    overlay.querySelector('.bw-lb-close').focus();
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    // Assigning '' resolves against the page URL and fires a stray request for
    // the document itself in some browsers.
    imgEl.removeAttribute('src');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('img') : null;
    if (!el || !el.matches(SELECTORS)) return;
    // A linked image is navigation. Let it navigate.
    if (el.closest('a')) return;
    e.preventDefault();
    open(el);
  });

  document.addEventListener('keydown', function (e) {
    if (!overlay || !overlay.classList.contains('active')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // Swipe on touch, since that is how a phone expects to page a gallery.
  (function () {
    var x0 = null;
    document.addEventListener('touchstart', function (e) {
      if (overlay && overlay.classList.contains('active')) x0 = e.touches[0].clientX;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      x0 = null;
    }, { passive: true });
  })();
})();
