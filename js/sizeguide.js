/* ── INLINE SIZE GUIDE ──
   Product pages tell a buyer four separate times to check the size guide, and
   every one of those was a full navigation away from the page — losing the
   variant they had selected and making them find the product again. That is
   friction at the worst possible moment, because wrong size is the one thing
   the refund policy explicitly does not cover: "all sales are final ... ordering
   the wrong size". The measurements need to be reachable without leaving.

   Per-product measurements were the obvious idea and are not safe: only 22 of
   63 products name their blank anywhere in the Printify data, so the other 37
   would have to be guessed, and showing someone the wrong chest measurement
   causes exactly the mis-order this is meant to prevent. Instead the real size
   guide is fetched on demand and shown in place, so every product gets the same
   accurate tables with no duplicated copy to drift out of sync.

   Progressive enhancement: the links are ordinary hrefs, so with no JS, a fetch
   failure, or a modified-click they navigate to /size-guide as before. */
(function () {
  var CACHE = null;      // the parsed guide, fetched at most once per pageview
  var overlay = null;
  var lastFocus = null;

  function injectCSS() {
    if (document.getElementById('bw-sg-css')) return;
    var css = [
      '.bw-sg{position:fixed;inset:0;z-index:2147483000;display:none;',
      'background:rgba(0,0,0,.82);padding:20px;overflow-y:auto;}',
      '.bw-sg.open{display:block;}',
      '.bw-sg-box{max-width:720px;margin:40px auto;background:#141414;',
      'border:1px solid #2a2a2a;border-radius:10px;padding:24px 24px 28px;',
      'position:relative;color:#ddd;}',
      '.bw-sg-box h2{color:#fff;font-size:19px;margin:0 0 4px;}',
      '.bw-sg-box h3{color:#fff;font-size:15px;margin:22px 0 8px;}',
      '.bw-sg-box p{color:#9a9a9a;font-size:14px;line-height:1.6;margin:0 0 10px;}',
      '.bw-sg-box table{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:13px;}',
      '.bw-sg-box th,.bw-sg-box td{border:1px solid #2a2a2a;padding:7px 9px;text-align:left;}',
      '.bw-sg-box th{background:#1c1c1c;color:#c8f135;font-weight:600;}',
      '.bw-sg-box td{color:#cfcfcf;}',
      '.bw-sg-close{position:absolute;top:10px;right:12px;background:#1a1a1a;',
      'color:#fff;border:1px solid #333;width:34px;height:34px;border-radius:50%;',
      'cursor:pointer;font-size:18px;line-height:1;}',
      '.bw-sg-full{display:inline-block;margin-top:14px;color:#c8f135;font-size:13px;}',
      '.bw-sg-scroll{overflow-x:auto;}',
      '@media(max-width:600px){.bw-sg-box{margin:12px auto;padding:20px 14px 24px;}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'bw-sg-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function build() {
    injectCSS();
    overlay = document.createElement('div');
    overlay.className = 'bw-sg';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Size guide');
    overlay.innerHTML = '<div class="bw-sg-box"><button class="bw-sg-close" '
      + 'aria-label="Close size guide">&times;</button>'
      + '<div class="bw-sg-body"><p>Loading measurements…</p></div>'
      + '<a class="bw-sg-full" href="/size-guide">Open the full size guide &rarr;</a></div>';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.className === 'bw-sg-close') close();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) close();
  });

  // Pull the tables and the "how to measure" copy out of the real page, so this
  // never states a measurement the size guide itself does not.
  function extract(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var main = doc.querySelector('main') || doc.body;
    var out = document.createElement('div');
    var nodes = main.querySelectorAll('h2, h3, table, p');
    var started = false;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var text = (n.textContent || '').trim();
      if (!started) {
        if (/how to measure/i.test(text)) started = true;
        else if (n.tagName !== 'TABLE') continue;
        else started = true;
      }
      if (/ready to find your shirt/i.test(text)) break;
      var clone = n.cloneNode(true);
      if (n.tagName === 'TABLE') {
        var wrap = document.createElement('div');
        wrap.className = 'bw-sg-scroll';
        wrap.appendChild(clone);
        out.appendChild(wrap);
      } else {
        out.appendChild(clone);
      }
    }
    return out.children.length ? out : null;
  }

  function open(trigger) {
    lastFocus = trigger || null;
    var el = overlay || build();
    el.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    var body = el.querySelector('.bw-sg-body');
    var closeBtn = el.querySelector('.bw-sg-close');
    if (closeBtn) closeBtn.focus();

    if (CACHE) { body.innerHTML = ''; body.appendChild(CACHE.cloneNode(true)); return; }

    fetch('/size-guide', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('size guide ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var frag = extract(html);
        if (!frag) throw new Error('no tables found');
        CACHE = frag;
        body.innerHTML = '';
        body.appendChild(frag.cloneNode(true));
      })
      .catch(function () {
        // Never strand the buyer in an empty dialog — send them to the page.
        window.location.href = '/size-guide';
      });
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href$="/size-guide"]') : null;
    if (!a) return;
    // Leave modified clicks alone: a new tab is a deliberate choice.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (a.classList.contains('bw-sg-full')) return;
    e.preventDefault();
    open(a);
  });
})();
