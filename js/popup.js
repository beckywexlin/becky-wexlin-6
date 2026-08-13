/* ── EMAIL CAPTURE ──
   One Klaviyo subscribe path, two places to reach it: the popup, and a
   permanent form in the footer.

   The footer form exists because the popup used to be the only way in and it
   suppressed itself forever after a single dismissal. Now that the discount
   code is no longer printed in the announcement bar, a visitor who closed the
   popup once in March would otherwise see an offer with no way to claim it.
   The dismissal is now a 30-day snooze rather than a life sentence. */
(function () {
  if (window.location.pathname.indexOf('checkout') > -1) return;

  var KLAVIYO_COMPANY_ID = 'SSfm5P';
  var KLAVIYO_LIST_ID = 'Vs8hPU';
  var DISMISS_DAYS = 30;

  var SUBSCRIBED_KEY = 'bw_popup_subscribed';
  var DISMISSED_AT_KEY = 'bw_popup_dismissed_at';
  var LEGACY_KEY = 'bw_popup_dismissed';

  function ls(fn, fallback) {
    // Safari private mode throws on localStorage. A storage failure should cost
    // the suppression, never the form.
    try { return fn(); } catch (e) { return fallback; }
  }

  function hasSubscribed() {
    return ls(function () { return !!localStorage.getItem(SUBSCRIBED_KEY); }, false);
  }

  function snoozed() {
    return ls(function () {
      // The old flag was a bare '1' with no timestamp, set on dismiss AND on
      // successful subscribe, so it can't be told apart or expired. Clear it and
      // let those visitors see the popup again — they are exactly the people
      // currently locked out of the only route to the code.
      if (localStorage.getItem(LEGACY_KEY)) localStorage.removeItem(LEGACY_KEY);
      var at = Number(localStorage.getItem(DISMISSED_AT_KEY) || 0);
      return at > 0 && Date.now() - at < DISMISS_DAYS * 864e5;
    }, false);
  }

  // ── shared subscribe ──────────────────────────────────────────────────
  // fetch() only rejects on network failure — a 400 from Klaviyo resolves
  // normally. The response went unchecked for months, so rejected subscribes
  // still showed "Check your inbox!" and nothing was logged anywhere.
  async function subscribe(email, source) {
    var res = await fetch(
      'https://a.klaviyo.com/client/subscriptions/?company_id=' + KLAVIYO_COMPANY_ID,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'revision': '2024-10-15' },
        body: JSON.stringify({
          data: {
            type: 'subscription',
            attributes: {
              profile: { data: { type: 'profile', attributes: { email: email } } },
              custom_source: source,
            },
            relationships: { list: { data: { type: 'list', id: KLAVIYO_LIST_ID } } },
          },
        }),
      }
    );
    if (!res.ok) {
      var detail = await res.text().catch(function () { return ''; });
      throw new Error('Klaviyo HTTP ' + res.status + ' ' + detail.slice(0, 200));
    }
    ls(function () { localStorage.setItem(SUBSCRIBED_KEY, '1'); });
    if (typeof gtag === 'function') gtag('event', 'generate_lead', { method: source });
  }

  function reportFailure(err, source) {
    // A silent failure here is invisible in both Klaviyo and GA4.
    console.error('subscribe failed (' + source + '):', err && err.message);
    if (typeof gtag === 'function') {
      gtag('event', 'exception', { description: 'subscribe_failed_' + source, fatal: false });
    }
  }

  // ── footer form ───────────────────────────────────────────────────────
  function injectFooterForm() {
    var footer = document.querySelector('.site-footer');
    if (!footer || document.getElementById('footer-signup')) return;

    var style = document.createElement('style');
    style.textContent =
      '#footer-signup{border-top:1px solid #2A2A2A;margin:32px 0 0;padding:28px 0 4px;}' +
      '#footer-signup h3{font-size:15px;letter-spacing:.02em;color:#F8F8F0;margin:0 0 6px;font-weight:500;}' +
      '#footer-signup p{font-size:13.5px;color:#8A8A8A;margin:0 0 14px;line-height:1.6;}' +
      '#footer-signup form{display:flex;gap:8px;flex-wrap:wrap;max-width:420px;}' +
      '#footer-signup input{flex:1 1 200px;min-width:0;padding:11px 13px;border:1px solid #2A2A2A;' +
        'border-radius:6px;background:#111;color:#F8F8F0;font:inherit;font-size:14px;}' +
      '#footer-signup input:focus{outline:none;border-color:#AAEE00;}' +
      '#footer-signup button{padding:11px 18px;border:0;border-radius:6px;background:#AAEE00;' +
        'color:#0A0A0A;font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;}' +
      '#footer-signup button:disabled{opacity:.6;cursor:default;}' +
      '#footer-signup .fs-msg{margin:12px 0 0;font-size:13.5px;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'footer-signup';
    wrap.innerHTML =
      '<h3>Get 10% off your first order</h3>' +
      '<p>Join the list for the discount code, new drops and the occasional bad joke.</p>' +
      '<form novalidate>' +
        '<label for="footer-signup-email" class="sr-only" ' +
          'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Email address</label>' +
        '<input type="email" id="footer-signup-email" placeholder="your@email.com" ' +
          'autocomplete="email" required />' +
        '<button type="submit">Get my code</button>' +
      '</form>' +
      '<p class="fs-msg" style="display:none;"></p>';

    var grid = footer.querySelector('.footer-grid');
    if (grid && grid.parentNode) grid.parentNode.insertBefore(wrap, grid.nextSibling);
    else footer.appendChild(wrap);

    var form = wrap.querySelector('form');
    var input = wrap.querySelector('input');
    var btn = wrap.querySelector('button');
    var msg = wrap.querySelector('.fs-msg');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = input.value.trim();
      if (!email || email.indexOf('@') < 1) {
        msg.textContent = 'That email doesn’t look right.';
        msg.style.color = '#ff00cc';
        msg.style.display = '';
        return;
      }
      btn.textContent = 'Subscribing…';
      btn.disabled = true;
      try {
        await subscribe(email, 'Website Footer - 10% Off');
        form.style.display = 'none';
        msg.textContent = 'Check your inbox for your 10% off code.';
        msg.style.color = '#AAEE00';
        msg.style.display = '';
      } catch (err) {
        reportFailure(err, 'footer');
        btn.textContent = 'Get my code';
        btn.disabled = false;
        msg.textContent = 'Something went wrong. Try again.';
        msg.style.color = '#ff00cc';
        msg.style.display = '';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFooterForm);
  } else {
    injectFooterForm();
  }

  // ── popup ─────────────────────────────────────────────────────────────
  if (hasSubscribed() || snoozed()) return;

  var popup = document.createElement('div');
  popup.id = 'email-popup';
  popup.innerHTML =
    '<div class="email-popup-backdrop"></div>' +
    '<div class="email-popup-card">' +
      '<button class="email-popup-close" aria-label="Close">&times;</button>' +
      '<p class="email-popup-eyebrow">Join the weirdos</p>' +
      '<h2 class="email-popup-title">Get <span style="color:#AAEE00;">10% off</span> your first order</h2>' +
      '<p class="email-popup-sub">Drop your email and we\'ll send you a discount code. No spam, just shirts.</p>' +
      '<form class="email-popup-form" id="email-popup-form">' +
        '<input type="email" id="popup-email" placeholder="your@email.com" required />' +
        '<button type="submit" class="btn btn-primary" style="width:100%; padding:14px;">Get my 10% off</button>' +
      '</form>' +
      '<p class="email-popup-msg" id="popup-msg" style="display:none;"></p>' +
      '<p class="email-popup-fine">Unsubscribe anytime. We respect your inbox.</p>' +
    '</div>';
  document.body.appendChild(popup);

  // A modal at 5 seconds that also locks scrolling interrupts people before
  // they've seen anything, and 53% of sessions are mobile where a scroll lock
  // feels like a dead page. Show it once the visitor has actually engaged —
  // scrolled a bit, spent real time, or is leaving — and never freeze the page
  // on touch devices.
  var shown = false;
  var isTouch = window.matchMedia('(hover: none)').matches;

  function show() {
    if (shown) return;
    shown = true;
    popup.classList.add('active');
    if (!isTouch) document.body.style.overflow = 'hidden';
    if (typeof gtag === 'function') gtag('event', 'popup_shown', { method: 'popup' });
  }

  function onScroll() {
    var d = document.documentElement;
    var pct = (window.scrollY + window.innerHeight) / Math.max(d.scrollHeight, 1);
    if (pct > 0.45) { show(); window.removeEventListener('scroll', onScroll); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  setTimeout(show, 30000);

  // Desktop exit intent — the one moment interrupting is genuinely warranted.
  if (!isTouch) {
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget && e.clientY <= 0) show();
    });
  }

  function close() {
    popup.classList.remove('active');
    document.body.style.overflow = '';
    // A snooze, not a life sentence — they can still find the footer form
    // in the meantime.
    ls(function () { localStorage.setItem(DISMISSED_AT_KEY, String(Date.now())); });
  }

  popup.querySelector('.email-popup-close').addEventListener('click', close);
  popup.querySelector('.email-popup-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && popup.classList.contains('active')) close();
  });

  document.getElementById('email-popup-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = document.getElementById('popup-email').value.trim();
    if (!email) return;

    var btn = this.querySelector('button[type="submit"]');
    btn.textContent = 'Subscribing...';
    btn.disabled = true;

    try {
      await subscribe(email, 'Website Popup - 10% Off');
      document.getElementById('email-popup-form').style.display = 'none';
      var msg = document.getElementById('popup-msg');
      msg.textContent = 'Check your inbox for your 10% off code!';
      msg.style.display = '';
      msg.style.color = '#AAEE00';
      setTimeout(close, 3000);
    } catch (err) {
      reportFailure(err, 'popup');
      btn.textContent = 'Get my 10% off';
      btn.disabled = false;
      var msg2 = document.getElementById('popup-msg');
      msg2.textContent = 'Something went wrong. Try again.';
      msg2.style.display = '';
      msg2.style.color = '#ff00cc';
    }
  });
})();
