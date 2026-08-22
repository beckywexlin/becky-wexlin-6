/* ── IMAGE LIGHTBOX ──
   Product mockups are served at 1200x1200 but displayed at 800px, and only
   420px on mobile, so the print detail that sells a shirt was never visible.

   Styles are injected here rather than living in style.css on purpose. CSS and
   JS were served with `immutable, max-age=31536000` under non-versioned
   filenames until 2026-08-18, so returning visitors hold a year-long cached
   copy of style.css that will never revalidate. A lightbox whose positioning
   lives in that file renders as a plain block at the foot of the document and
   clicking an image just scrolls you to the bottom. Self-contained styles can't
   be defeated that way.

   Deliberately NOT applied to images inside a link: shop cards, collection
   tiles, the strip and the logos all navigate somewhere, and hijacking those
   clicks would break browsing. */
(function () {
  var SELECTORS = '.product-main-img img, .post-content img';

  var overlay, imgEl, capEl, prevBtn, nextBtn, counter, rail, spinner;
  var group = [];
  var index = 0;
  var lastFocus = null;
  var lastScroll = 0;

  var CSS = [
    '.bw-lightbox{position:fixed;inset:0;z-index:2147483000;display:none;',
      'align-items:center;justify-content:center;flex-direction:column;',
      'background:rgba(8,8,8,.95);padding:24px;}',
    '.bw-lightbox.bw-open{display:flex;}',
    '.bw-lb-stage{position:relative;display:flex;align-items:center;justify-content:center;',
      'max-width:100%;flex:1 1 auto;min-height:0;width:100%;}',
    '.bw-lb-img{max-width:min(1100px,90vw);max-height:74vh;width:auto;height:auto;',
      'object-fit:contain;border-radius:4px;cursor:zoom-out;display:block;}',
    '.bw-lb-cap{font-size:13px;line-height:1.5;color:#9a9a9a;text-align:center;',
      'max-width:60ch;margin:14px auto 0;}',
    '.bw-lb-close{position:absolute;top:14px;right:18px;width:44px;height:44px;',
      'font-size:30px;line-height:1;color:#F8F8F0;background:transparent;border:0;',
      'cursor:pointer;z-index:2;}',
    '.bw-lb-close:hover{color:#AAEE00;}',
    '.bw-lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;',
      'font-size:24px;color:#F8F8F0;background:rgba(0,0,0,.5);border:1px solid #333;',
      'border-radius:50%;cursor:pointer;z-index:2;display:flex;align-items:center;',
      'justify-content:center;}',
    '.bw-lb-nav:hover{border-color:#AAEE00;color:#AAEE00;}',
    '.bw-lb-prev{left:10px;}.bw-lb-next{right:10px;}',
    '.bw-lb-count{font-size:12px;letter-spacing:.14em;color:#777;margin-top:10px;}',
    /* Thumbnail rail, the way Amazon and Nordstrom present a gallery. */
    '.bw-lb-rail{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;',
      'margin-top:14px;max-width:90vw;}',
    '.bw-lb-rail button{width:56px;height:56px;padding:0;border:1px solid #333;',
      'background:#111;border-radius:4px;overflow:hidden;cursor:pointer;flex:0 0 auto;}',
    '.bw-lb-rail button.bw-on{border-color:#AAEE00;}',
    '.bw-lb-rail img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.bw-lb-spin{position:absolute;width:34px;height:34px;border:3px solid #333;',
      'border-top-color:#AAEE00;border-radius:50%;animation:bw-spin .8s linear infinite;}',
    '@keyframes bw-spin{to{transform:rotate(360deg);}}',
    /* The only affordance telling anyone the image is clickable. */
    SELECTORS.split(',').map(function (s) { return s.trim(); }).join(',') + '{cursor:zoom-in;}',
    '@media(max-width:700px){',
      '.bw-lightbox{padding:10px;}',
      '.bw-lb-img{max-height:62vh;max-width:96vw;}',
      '.bw-lb-nav{width:40px;height:40px;font-size:18px;}',
      '.bw-lb-prev{left:2px;}.bw-lb-next{right:2px;}',
      '.bw-lb-rail button{width:44px;height:44px;}',
    '}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('bw-lightbox-css')) return;
    var st = document.createElement('style');
    st.id = 'bw-lightbox-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'bw-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Enlarged image');
    overlay.tabIndex = -1;
    overlay.innerHTML =
      '<button class="bw-lb-close" aria-label="Close">&times;</button>' +
      '<div class="bw-lb-stage">' +
        '<button class="bw-lb-nav bw-lb-prev" aria-label="Previous image">&#8592;</button>' +
        '<div class="bw-lb-spin"></div>' +
        '<img class="bw-lb-img" alt="" />' +
        '<button class="bw-lb-nav bw-lb-next" aria-label="Next image">&#8594;</button>' +
      '</div>' +
      '<p class="bw-lb-cap"></p>' +
      '<div class="bw-lb-rail"></div>' +
      '<div class="bw-lb-count"></div>';
    document.body.appendChild(overlay);

    imgEl   = overlay.querySelector('.bw-lb-img');
    capEl   = overlay.querySelector('.bw-lb-cap');
    prevBtn = overlay.querySelector('.bw-lb-prev');
    nextBtn = overlay.querySelector('.bw-lb-next');
    counter = overlay.querySelector('.bw-lb-count');
    rail    = overlay.querySelector('.bw-lb-rail');
    spinner = overlay.querySelector('.bw-lb-spin');

    imgEl.addEventListener('load', function () { spinner.style.display = 'none'; });
    overlay.querySelector('.bw-lb-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    overlay.addEventListener('click', function (e) {
      // Backdrop or the picture itself (it carries a zoom-out cursor).
      if (e.target === overlay || e.target === imgEl
          || e.target.classList.contains('bw-lb-stage')) close();
    });
  }

  /* The gallery a click belongs to. On a product page the thumbnails hold the
     images for the CURRENT colour, which is the set worth paging through. */
  function galleryFor(el) {
    if (el.closest('.product-main-img')) {
      var thumbs = document.querySelectorAll('.product-thumbs img');
      if (thumbs.length > 1) return Array.prototype.slice.call(thumbs);
    }
    var post = el.closest('.post-content');
    if (post) return Array.prototype.slice.call(post.querySelectorAll('img'));
    return [el];
  }

  // <picture> serves a webp/jpeg pair; currentSrc is what the browser chose.
  function bestSrc(el) { return el.currentSrc || el.src; }

  function show(i) {
    if (!group.length) return;
    index = (i + group.length) % group.length;
    var it = group[index];
    spinner.style.display = '';
    imgEl.src = it.src;
    imgEl.alt = it.alt || '';
    capEl.textContent = it.alt || '';
    capEl.style.display = it.alt ? '' : 'none';

    var many = group.length > 1;
    prevBtn.style.display = many ? '' : 'none';
    nextBtn.style.display = many ? '' : 'none';
    rail.style.display = many ? '' : 'none';
    counter.style.display = many ? '' : 'none';
    counter.textContent = (index + 1) + ' / ' + group.length;

    Array.prototype.forEach.call(rail.children, function (b, n) {
      b.classList.toggle('bw-on', n === index);
    });
  }

  function step(d) { show(index + d); }

  function open(el) {
    injectCSS();
    build();
    group = galleryFor(el).map(function (n) {
      return { src: bestSrc(n), alt: n.alt || '' };
    });

    rail.innerHTML = '';
    group.forEach(function (g, n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'View image ' + (n + 1));
      b.innerHTML = '<img src="' + g.src + '" alt="" loading="lazy" />';
      b.addEventListener('click', function (e) { e.stopPropagation(); show(n); });
      rail.appendChild(b);
    });

    var here = bestSrc(el);
    var start = -1;
    for (var k = 0; k < group.length; k++) { if (group[k].src === here) { start = k; break; } }

    lastFocus = document.activeElement;
    lastScroll = window.scrollY || window.pageYOffset || 0;
    show(start > -1 ? start : 0);
    overlay.classList.add('bw-open');
    document.body.style.overflow = 'hidden';
    // preventScroll matters: without it the browser scrolls the document to
    // wherever the overlay sits, which is the bottom of the page.
    try { overlay.focus({ preventScroll: true }); } catch (e) { /* older Safari */ }
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('bw-open');
    document.body.style.overflow = '';
    // '' resolves against the page URL and refetches the document in some
    // browsers; removing the attribute does not.
    imgEl.removeAttribute('src');
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    window.scrollTo(0, lastScroll);
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('img') : null;
    if (!el || !el.matches(SELECTORS)) return;
    if (el.closest('a')) return;          // a linked image is navigation
    e.preventDefault();
    open(el);
  });

  document.addEventListener('keydown', function (e) {
    if (!overlay || !overlay.classList.contains('bw-open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // Swipe, since that is how a phone expects to page a gallery.
  var x0 = null;
  document.addEventListener('touchstart', function (e) {
    if (overlay && overlay.classList.contains('bw-open')) x0 = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });

  injectCSS();
})();
