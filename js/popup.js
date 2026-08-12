/* ── EMAIL CAPTURE POPUP ── */
(function () {
  // Don't show on checkout or if already dismissed/subscribed
  if (window.location.pathname.indexOf('checkout') > -1) return;
  if (localStorage.getItem('bw_popup_dismissed')) return;

  var KLAVIYO_COMPANY_ID = 'SSfm5P';
  var KLAVIYO_LIST_ID = ''; // Will be set below after fetching

  // Build popup HTML
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
  // feels like a dead page. Average session time and pages/session both fell
  // sharply this period. Show it once the visitor has actually engaged —
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
    localStorage.setItem('bw_popup_dismissed', '1');
  }

  popup.querySelector('.email-popup-close').addEventListener('click', close);
  popup.querySelector('.email-popup-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && popup.classList.contains('active')) close();
  });

  // Submit
  document.getElementById('email-popup-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = document.getElementById('popup-email').value.trim();
    if (!email) return;

    var btn = this.querySelector('button[type="submit"]');
    btn.textContent = 'Subscribing...';
    btn.disabled = true;

    try {
      // Subscribe via Klaviyo client API
      // fetch() only rejects on network failure — a 400 from Klaviyo resolves
      // normally. The response was never checked, so a rejected subscribe still
      // showed "Check your inbox!" and nothing was ever logged. That is almost
      // certainly why the list shows 0 new subscribers while the form appears
      // to work.
      var res = await fetch('https://a.klaviyo.com/client/subscriptions/?company_id=' + KLAVIYO_COMPANY_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'revision': '2024-10-15' },
        body: JSON.stringify({
          data: {
            type: 'subscription',
            attributes: {
              profile: { data: { type: 'profile', attributes: { email: email } } },
              custom_source: 'Website Popup - 10% Off',
            },
            relationships: {
              list: { data: { type: 'list', id: 'Vs8hPU' } },
            },
          },
        }),
      });

      if (!res.ok) {
        var detail = await res.text().catch(function () { return ''; });
        throw new Error('Klaviyo HTTP ' + res.status + ' ' + detail.slice(0, 200));
      }

      if (typeof gtag === 'function') {
        gtag('event', 'generate_lead', { method: 'popup' });
      }

      document.getElementById('email-popup-form').style.display = 'none';
      var msg = document.getElementById('popup-msg');
      msg.textContent = 'Check your inbox for your 10% off code!';
      msg.style.display = '';
      msg.style.color = '#AAEE00';
      localStorage.setItem('bw_popup_dismissed', '1');
      setTimeout(close, 3000);
    } catch (err) {
      // Log it. A silent failure here is invisible in both Klaviyo and GA4.
      console.error('popup subscribe failed:', err && err.message);
      if (typeof gtag === 'function') {
        gtag('event', 'exception', { description: 'popup_subscribe_failed', fatal: false });
      }
      btn.textContent = 'Get my 10% off';
      btn.disabled = false;
      var msg = document.getElementById('popup-msg');
      msg.textContent = 'Something went wrong. Try again.';
      msg.style.display = '';
      msg.style.color = '#ff00cc';
    }
  });
})();
