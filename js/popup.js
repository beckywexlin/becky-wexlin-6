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

  // Show after 5 seconds
  setTimeout(function () {
    popup.classList.add('active');
    document.body.style.overflow = 'hidden';
  }, 5000);

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
      await fetch('https://a.klaviyo.com/client/subscriptions/?company_id=' + KLAVIYO_COMPANY_ID, {
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

      document.getElementById('email-popup-form').style.display = 'none';
      var msg = document.getElementById('popup-msg');
      msg.textContent = 'Check your inbox for your 10% off code!';
      msg.style.display = '';
      msg.style.color = '#AAEE00';
      localStorage.setItem('bw_popup_dismissed', '1');
      setTimeout(close, 3000);
    } catch (err) {
      btn.textContent = 'Get my 10% off';
      btn.disabled = false;
      var msg = document.getElementById('popup-msg');
      msg.textContent = 'Something went wrong. Try again.';
      msg.style.display = '';
      msg.style.color = '#ff00cc';
    }
  });
})();
