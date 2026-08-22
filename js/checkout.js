/* ============================================
   BECKY WEXLIN CREATIVE — Checkout
   ============================================ */

const CHECKOUT_WORKER = 'https://checkout.beckywexlin.workers.dev';

let stripe;
let elements;
let paymentElement;
let currentTaxAmount = 0;
let taxCalculationId = null;
let taxDebounce = null;
let currentPaymentIntentId = null;
let currentClientSecret = null;
let currentPromoCode = '';
let currentDiscount = 0;

// ── INIT STRIPE ──
async function initStripe() {
  const res = await fetch(CHECKOUT_WORKER + '/config');
  const { publishableKey } = await res.json();
  stripe = Stripe(publishableKey);
}

// ── CREATE PAYMENT INTENT ──
async function createPaymentIntent(items, tax) {
  const res = await fetch(CHECKOUT_WORKER + '/create-payment-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, tax: tax || 0, taxCalculationId, promoCode: currentPromoCode })
  });
  const data = await res.json();
  currentPaymentIntentId = data.paymentIntentId;
  currentClientSecret = data.clientSecret;
  return data.clientSecret;
}

// ── MOUNT PAYMENT ELEMENT ──
async function mountPaymentElement(clientSecret) {
  elements = stripe.elements({ clientSecret });
  paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');
}

// ── EXPRESS (WALLET) CHECKOUT ─────────────────────────────────────
// Apple Pay inside the Payment Element authorises a payment and nothing more —
// it never populates the address form, so tapping it still left someone typing
// their whole address, which defeats the point of a wallet on a phone. The
// Express Checkout Element asks the wallet for the shipping address too.
//
// It needs its OWN Elements instance created with mode/amount/currency. The
// Payment Element's instance is built from a clientSecret, and mounting the
// Express Checkout Element on that renders a button that does nothing at all
// when tapped — no sheet, no error.
//
// Strictly additive: it hides itself unless a wallet is available and any
// failure leaves the card form exactly as it was.
let expressElements = null;

async function mountExpressCheckout() {
  const wrap = document.getElementById('express-checkout-wrap');
  const mountPoint = document.getElementById('express-checkout');
  if (!wrap || !mountPoint || !stripe) return;

  const totalCents = orderTotalCents();
  // A fully discounted order never touches Stripe, so a wallet button would be
  // a dead end. Stripe also rejects a zero amount here.
  if (totalCents <= 0) return;

  const blocked = (window.BW_SHIPPING && window.BW_SHIPPING.BLOCKED) || {};
  const RATES = [{ id: 'free', displayName: 'Free shipping', amount: 0,
                   deliveryEstimate: { minimum: { unit: 'day', value: 5 },
                                       maximum: { unit: 'day', value: 10 } } }];

  expressElements = stripe.elements({
    mode: 'payment',
    amount: totalCents,
    currency: 'usd',
  });

  const express = expressElements.create('expressCheckout', {
    emailRequired: true,
    shippingAddressRequired: true,
    shippingRates: RATES,
  });

  // Stripe reports which wallets this device can actually use. Showing an "or
  // pay by card" divider to everyone else would be noise.
  express.on('ready', (e) => {
    const available = e && e.availablePaymentMethods;
    if (available && Object.keys(available).length) wrap.style.display = '';
  });

  // The wallet hands over a partial address here on purpose — in the US often
  // just city, state and postcode. Enough to price tax, not enough to identify
  // anyone before they commit.
  express.on('shippingaddresschange', async (e) => {
    const addr = e.address || {};
    const country = (addr.country || 'US').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(blocked, country)) {
      e.reject();
      return;
    }
    try {
      const res = await fetch(CHECKOUT_WORKER + '/calculate-tax', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: JSON.parse(localStorage.getItem('bw-cart') || '[]'),
          address: {
            line1: addr.line1 || '',
            city: addr.city || '',
            state: addr.state || '',
            postal_code: addr.postal_code || '',
            country: country,
          },
        }),
      });
      if (res.ok) {
        const t = await res.json();
        currentTaxAmount = t.tax || 0;
        taxCalculationId = t.taxCalculationId || null;
        updateTotal();
        // The sheet shows this total, so it has to move with the tax.
        expressElements.update({ amount: Math.max(orderTotalCents(), 50) });
      }
    } catch (err) {
      // A tax lookup failure must not strand the open wallet sheet.
      console.error('express tax lookup failed:', err && err.message);
    }
    e.resolve({ shippingRates: RATES });
  });

  express.on('confirm', async (e) => {
    const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');
    const a = (e.shippingAddress && e.shippingAddress.address) || {};
    const fullName = (e.shippingAddress && e.shippingAddress.name) || '';
    const country = (a.country || 'US').toUpperCase();

    if (Object.prototype.hasOwnProperty.call(blocked, country)) {
      showCheckoutError(window.BW_SHIPPING
        ? window.BW_SHIPPING.message(country)
        : 'We are unable to ship to that destination.');
      return;
    }

    // Required before confirming in the deferred-intent flow — it validates and
    // collects everything the element gathered.
    const { error: submitError } = await expressElements.submit();
    if (submitError) {
      showCheckoutError(submitError.message || 'That payment could not be completed.');
      return;
    }

    const parts = fullName.trim().split(/\s+/);
    const shipping = {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      email: (e.billingDetails && e.billingDetails.email) || '',
      phone: (e.billingDetails && e.billingDetails.phone) || '',
      address1: a.line1 || '',
      address2: a.line2 || '',
      city: a.city || '',
      state: a.state || '',
      zip: a.postal_code || '',
      country: country,
    };

    // The intent was created before the wallet knew the destination, so bring
    // it up to the final total before charging.
    try {
      const piRes = await fetch(CHECKOUT_WORKER + '/update-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          tax: currentTaxAmount,
          taxCalculationId,
          paymentIntentId: currentPaymentIntentId,
          promoCode: currentPromoCode,
          country: country,
        }),
      });
      if (!piRes.ok) {
        showCheckoutError('We could not finalise your total. Please try again.');
        return;
      }
    } catch (err) {
      showCheckoutError('We could not finalise your total. Please try again.');
      return;
    }

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements: expressElements,
      clientSecret: currentClientSecret,
      confirmParams: { return_url: window.location.origin + '/order-success' },
      redirect: 'if_required',
    });

    if (error) {
      const shopperFacing = error.type === 'card_error' || error.type === 'validation_error';
      showCheckoutError(shopperFacing && error.message
        ? error.message
        : 'That payment could not be completed. Please try again or use a card.');
      return;
    }

    const orderRes = await fetch(CHECKOUT_WORKER + '/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart,
        shipping,
        paymentIntentId: paymentIntent.id,
        promoCode: currentPromoCode || '',
        gaClientId: readGaClientId(),
      }),
    });

    if (!orderRes || !orderRes.ok) {
      let detail = '';
      try { detail = (await orderRes.json()).error || ''; } catch (err) {}
      showCheckoutError(
        'Your payment went through, but we could not create the order'
        + (detail ? ' (' + detail + ')' : '')
        + '. Email hello@beckywexlin.com with this reference and we will sort it out: '
        + paymentIntent.id);
      return;
    }

    localStorage.removeItem('bw-cart');
    localStorage.removeItem('bw-shipping');
    window.location.href = '/order-success';
  });

  try {
    express.mount(mountPoint);
  } catch (err) {
    console.error('express checkout mount failed:', err && err.message);
  }
}

// ── SHIPPING ELIGIBILITY ──────────────────────────────────────────
// Restricted destinations are absent from the country <select>, so this path
// is reached two ways: the address autocomplete resolving to one, or someone
// editing the form value. Either way the customer gets a plain explanation
// instead of a failed charge. The checkout worker enforces the same list
// server-side — this is the courtesy layer, not the control.
function showBlockedCountryNotice(code) {
  const box = document.getElementById('blocked-country-notice');
  const msg = document.getElementById('blocked-country-message');
  if (!box || !msg || !window.BW_SHIPPING) return;

  msg.textContent = window.BW_SHIPPING.message(code);
  box.hidden = false;
  box.style.display = '';
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const btn = document.getElementById('checkout-submit');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Unable to ship to this address';
  }
}

function clearBlockedCountryNotice() {
  const box = document.getElementById('blocked-country-notice');
  if (box && !box.hidden) {
    box.hidden = true;
    box.style.display = 'none';
    const btn = document.getElementById('checkout-submit');
    if (btn) { btn.disabled = false; btn.textContent = 'Place order'; }
  }
}

// Not every country has states or postal codes. Marking both hard-required
// made checkout impossible from places like Hong Kong, Ireland or the UAE.
function applyAddressRulesFor(country) {
  const S = window.BW_SHIPPING;
  if (!S) return;

  const zip = document.getElementById('zip');
  const state = document.getElementById('state');
  const zipLabel = document.querySelector('label[for="zip"]');
  const stateLabel = document.querySelector('label[for="state"]');

  const zipNeeded = S.needsPostal(country);
  const regionNeeded = country === 'US' || S.needsRegion(country);

  if (zip) {
    zip.required = zipNeeded;
    zip.placeholder = zipNeeded ? 'ZIP / Postal code' : 'Not used in this country';
  }
  if (zipLabel) zipLabel.textContent = zipNeeded ? 'ZIP / Postal code' : 'Postal code (optional)';

  if (state) {
    state.required = regionNeeded;
    state.placeholder = country === 'US' ? 'e.g. CA' : 'State / Province / Region';
  }
  if (stateLabel) {
    stateLabel.textContent = regionNeeded ? 'State / Province' : 'State / Province (optional)';
  }
}

// ── CALCULATE TAX ──
async function calculateTax() {
  const state = document.getElementById('state').value.trim();
  const zip = document.getElementById('zip').value.trim();
  const city = document.getElementById('city').value.trim();
  const country = document.getElementById('country').value || 'US';
  const address1 = document.getElementById('address1').value.trim();

  // Restricted destination — surface it as soon as the country is known,
  // which for most people is while they're still filling in the address.
  if (window.BW_SHIPPING && window.BW_SHIPPING.isBlocked(country)) {
    showBlockedCountryNotice(country);
    document.getElementById('checkout-tax').textContent = '—';
    return;
  }
  clearBlockedCountryNotice();

  // Only calculate tax for US customers (Stripe Tax only supports US)
  // International customers will have $0 tax
  if (country !== 'US') {
    document.getElementById('checkout-tax').textContent = '$0.00';
    document.getElementById('checkout-tax').style.color = 'var(--lime)';
    currentTaxAmount = 0;
    updateTotal();
    return;
  }

  // Need at least state + zip to calculate tax for US
  if (!state || !zip || zip.length < 5) return;

  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');
  if (!cart.length) return;

  const taxEl = document.getElementById('checkout-tax');
  taxEl.textContent = 'Calculating...';
  taxEl.style.color = '#777';

  try {
    const res = await fetch(CHECKOUT_WORKER + '/calculate-tax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart,
        address: { line1: address1, city, state, postal_code: zip, country }
      })
    });
    // The worker refuses restricted destinations here too, which is usually
    // the first time a customer finds out.
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      if (body.blocked) {
        const msg = document.getElementById('blocked-country-message');
        if (msg && body.message) msg.textContent = body.message;
        showBlockedCountryNotice(country);
        taxEl.textContent = '—';
        return;
      }
    }

    const data = await res.json();

    if (data.tax_amount !== undefined) {
      currentTaxAmount = data.tax_amount;
      taxCalculationId = data.tax_calculation_id || null;
      taxEl.textContent = currentTaxAmount > 0 ? '$' + currentTaxAmount.toFixed(2) : '$0.00';
      taxEl.style.color = currentTaxAmount > 0 ? '' : 'var(--lime)';
      updateTotal();
    } else {
      taxEl.textContent = '$0.00';
      taxEl.style.color = 'var(--lime)';
      currentTaxAmount = 0;
      updateTotal();
    }
  } catch (err) {
    taxEl.textContent = '$0.00';
    currentTaxAmount = 0;
    updateTotal();
  }
}

function updateTotal() {
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');
  const subtotal = cart.reduce((sum, item) => {
    return sum + parseFloat(item.price.replace('$', '')) * item.quantity;
  }, 0);
  const total = (subtotal - currentDiscount + currentTaxAmount).toFixed(2);
  document.getElementById('checkout-total').textContent = '$' + total;
}

function debounceTax() {
  clearTimeout(taxDebounce);
  taxDebounce = setTimeout(calculateTax, 500);
}


// A zero-total order: no card, no payment intent, straight to the worker. The
// reference is only an idempotency key for Printify — there is no charge to
// reconcile it against.
async function submitFreeOrder(shipping) {
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');
  const orderRes = await fetch(CHECKOUT_WORKER + '/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: cart,
      shipping,
      paymentIntentId: null,
      promoCode: currentPromoCode || '',
      gaClientId: readGaClientId()
    })
  });

  if (!orderRes || !orderRes.ok) {
    let detail = '';
    try { detail = (await orderRes.json()).error || ''; } catch (e) {}
    showCheckoutError('We could not place that order' + (detail ? ' (' + detail + ')' : '')
      + '. Please try again, or email hello@beckywexlin.com.');
    return false;
  }

  localStorage.removeItem('bw-cart');
  localStorage.removeItem('bw-shipping');
  window.location.href = '/order-success';
  return true;
}

// checkout.html has shipped a styled #checkout-error box since launch and
// nothing ever wrote to it. Every Stripe failure — declined card, failed 3-D
// Secure, expired card — was swallowed and the button simply un-greyed itself,
// so a shopper was told nothing and had no idea what to correct. 13 checkouts
// reached payment in 30 days and none completed.
function showCheckoutError(message) {
  const el = document.getElementById('checkout-error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // Without this a payment failure is invisible in analytics too, so the
  // funnel looks like abandonment rather than breakage.
  if (typeof gtag === 'function') {
    gtag('event', 'checkout_error', { description: String(message).slice(0, 120) });
  }
}

function clearCheckoutError() {
  const el = document.getElementById('checkout-error');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// ── SUBMIT ORDER ──
// True when a promo has taken the total to zero. Stripe cannot charge $0, so
// the amount used to be floored at 50 cents — a "100% off" code took real money
// while the confirmation email said $0.00. A free order skips Stripe entirely;
// the worker re-validates the promo server-side before it will accept one.
// _ga=GA1.1.123456789.1234567890 -> "123456789.1234567890"
function readGaClientId() {
  try {
    const c = document.cookie.split('; ').find(x => x.startsWith('_ga='));
    return c ? c.split('.').slice(2).join('.') : '';
  } catch (e) { return ''; }
}

function orderTotalCents() {
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');
  const subtotal = cart.reduce(
    (sum, item) => sum + parseFloat(String(item.price).replace('$', '')) * (item.quantity || 1), 0);
  return Math.round((subtotal - currentDiscount + currentTaxAmount) * 100);
}

async function submitOrder(shipping) {
  if (orderTotalCents() <= 0) return submitFreeOrder(shipping);

  const { error, paymentIntent } = await stripe.confirmPayment({
    elements,
    confirmParams: {
      return_url: window.location.origin + '/order-success',
      payment_method_data: {
        billing_details: {
          name: shipping.firstName + ' ' + shipping.lastName,
          email: shipping.email,
          address: {
            line1: shipping.address1,
            line2: shipping.address2 || '',
            city: shipping.city,
            state: shipping.state,
            postal_code: shipping.zip,
            country: shipping.country
          }
        }
      }
    },
    redirect: 'if_required'
  });

  if (error) {
    // Stripe's own copy is customer-facing and specific ("Your card was
    // declined", "Your card has expired"). Only card_error/validation_error
    // carry a message meant for shoppers; anything else gets a plain fallback
    // rather than leaking an internal string.
    const shopperFacing = error.type === 'card_error' || error.type === 'validation_error';
    showCheckoutError(
      shopperFacing && error.message
        ? error.message
        : 'We could not process that payment. Please check your card details or try another card.'
    );
    return false;
  }

  // Send order to Printify via worker
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');

  const gaClientId = readGaClientId();

  const orderRes = await fetch(CHECKOUT_WORKER + '/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: cart,
      shipping,
      paymentIntentId: paymentIntent.id,
      promoCode: currentPromoCode || '',
      gaClientId
    })
  });

  // Should be unreachable — the destination was already checked before payment.
  // If it happens, the card has been charged for an order that can't ship, so
  // say so plainly and keep the cart rather than showing a success page.
  if (orderRes && orderRes.status === 403) {
    const body = await orderRes.json().catch(() => ({}));
    if (body.blocked) {
      const msg = document.getElementById('blocked-country-message');
      if (msg) {
        msg.textContent = (body.message || window.BW_SHIPPING.message(shipping.country))
          + ' Your payment was authorised before we could stop it — email us and we will refund it in full straight away.';
      }
      showBlockedCountryNotice(shipping.country);
      return false;
    }
  }

  // The card is charged by this point. Redirecting to /order-success on a
  // failed create-order would clear the cart and tell the customer everything
  // worked while no order exists anywhere — the worst possible outcome, and
  // the previous behaviour for any non-403 failure.
  if (!orderRes || !orderRes.ok) {
    let detail = '';
    try { detail = (await orderRes.json()).error || ''; } catch (e) {}
    showCheckoutError(
      'Your payment went through, but we could not create the order'
      + (detail ? ' (' + detail + ')' : '')
      + '. Nothing has been lost — email hello@beckywexlin.com with this reference and we will sort it out or refund you: '
      + paymentIntent.id
    );
    if (typeof gtag === 'function') {
      gtag('event', 'exception', { description: 'create_order_failed_after_payment', fatal: true });
    }
    return false;
  }

  // GA4 purchase payload — stashed here, fired once on the order-success page
  // so a refresh can't re-send and there's a single source of truth.
  try {
    const subtotal = cart.reduce((sum, item) => sum + parseFloat(item.price.replace('$', '')) * item.quantity, 0);
    const purchaseParams = {
      transaction_id: paymentIntent.id,
      value: subtotal - currentDiscount + currentTaxAmount,
      tax: currentTaxAmount,
      shipping: 0,
      currency: 'USD',
      coupon: currentPromoCode || undefined,
      items: cart.map(item => ({
        item_id: item.id,
        item_name: item.title,
        item_variant: item.size || '',
        price: parseFloat(item.price.replace('$', '')),
        quantity: item.quantity,
        coupon: currentPromoCode || undefined
      }))
    };
    // Forward stored UTM params as custom dimensions for revenue attribution
    try {
      const utm = JSON.parse(sessionStorage.getItem('bw_utm') || '{}');
      if (utm.utm_source) purchaseParams.campaign_source = utm.utm_source;
      if (utm.utm_medium) purchaseParams.campaign_medium = utm.utm_medium;
      if (utm.utm_campaign) purchaseParams.campaign_name = utm.utm_campaign;
    } catch (e) {}
    localStorage.setItem('bw-purchase', JSON.stringify(purchaseParams));
  } catch (e) {}

  localStorage.removeItem('bw-cart');
  localStorage.removeItem('bw-shipping');
  window.location.href = '/order-success';
  return true;
}

// ── INIT CHECKOUT PAGE ──
async function initCheckout() {
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');

  if (cart.length === 0 && !window.location.search.includes('payment_intent')) {
    window.location.href = '/';
    return;
  }

  // GA4 begin_checkout event
  if (typeof gtag === 'function' && cart.length > 0) {
    const subtotal = cart.reduce((sum, item) => sum + parseFloat(item.price.replace('$', '')) * item.quantity, 0);
    gtag('event', 'begin_checkout', {
      currency: 'USD',
      value: subtotal,
      items: cart.map(item => ({
        item_id: item.id,
        item_name: item.title,
        item_variant: item.size || '',
        price: parseFloat(item.price.replace('$', '')),
        quantity: item.quantity
      }))
    });
  }

  // Render order summary
  const summary = document.getElementById('checkout-summary');
  if (summary) {
    summary.innerHTML = cart.map(item => `
      <div class="checkout-item">
        <div class="checkout-item-img">
          ${item.image ? `<img src="${item.image}" alt="${item.title}" />` : ''}
        </div>
        <div class="checkout-item-info">
          <p class="checkout-item-name">${item.title}</p>
          <p class="checkout-item-variant">${item.size || ''}</p>
          <p class="checkout-item-qty">Qty: ${item.quantity}</p>
        </div>
        <p class="checkout-item-price">${item.price}</p>
      </div>
    `).join('');

    const subtotal = cart.reduce((sum, item) => {
      return sum + parseFloat(item.price.replace('$', '')) * item.quantity;
    }, 0).toFixed(2);

    document.getElementById('checkout-subtotal').textContent = '$' + subtotal;
    document.getElementById('checkout-total').textContent = '$' + subtotal;
  }

  // Listen for address changes to recalculate tax
  ['state', 'zip', 'city', 'country', 'address1'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', debounceTax);
      el.addEventListener('blur', debounceTax);
    }
  });

  // Relabel the state and postal fields for whatever country is selected, so
  // people from countries without postcodes aren't blocked by a required field
  // they can't legitimately fill in.
  const countryEl = document.getElementById('country');
  if (countryEl) {
    countryEl.addEventListener('change', () => {
      const c = countryEl.value || 'US';
      if (window.BW_SHIPPING && window.BW_SHIPPING.isBlocked(c)) {
        showBlockedCountryNotice(c);
      } else {
        clearBlockedCountryNotice();
      }
      applyAddressRulesFor(c);
    });
    applyAddressRulesFor(countryEl.value || 'US');
  }

  // Auto-fill promo code from landing page (stored via ?code= param)
  const savedPromo = localStorage.getItem('bw-promo');

  // Promo code handler
  const promoBtn = document.getElementById('promo-apply');
  const promoInput = document.getElementById('promo-code');
  const promoMsg = document.getElementById('promo-msg');

  async function applyPromoCode(code) {
    if (!code) return;
    promoBtn.textContent = '...';
    promoBtn.disabled = true;
    try {
      const res = await fetch(CHECKOUT_WORKER + '/validate-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, items: cart }),
      });
      const data = await res.json();
      if (data.valid) {
        currentPromoCode = code;
        currentDiscount = data.discount;
        promoMsg.textContent = data.label + ' applied!';
        promoMsg.className = 'promo-success';
        promoMsg.style.display = '';
        promoInput.disabled = true;
        promoBtn.style.display = 'none';
        document.getElementById('discount-row').style.display = '';
        document.getElementById('discount-label').textContent = data.label;
        document.getElementById('discount-amount').textContent = '-$' + data.discount.toFixed(2);
        updateTotal();
        // Clear stored promo after successful apply
        localStorage.removeItem('bw-promo');
      } else {
        promoMsg.textContent = 'Invalid code';
        promoMsg.className = 'promo-error';
        promoMsg.style.display = '';
        currentPromoCode = '';
        currentDiscount = 0;
        localStorage.removeItem('bw-promo');
      }
    } catch {
      promoMsg.textContent = 'Could not validate';
      promoMsg.className = 'promo-error';
      promoMsg.style.display = '';
    }
    promoBtn.textContent = 'Apply';
    promoBtn.disabled = false;
  }

  // Auto-apply saved promo on page load
  if (savedPromo && promoInput) {
    promoInput.value = savedPromo;
    applyPromoCode(savedPromo);
  }

  if (promoBtn) {
    promoBtn.addEventListener('click', function() {
      applyPromoCode(promoInput.value.trim());
    });
  }

  // Klaviyo — Started Checkout event
  if (cart.length > 0) {
    var _learnq = window._learnq || [];
    var klaviyoItems = cart.map(function(item) {
      return {
        ProductID: item.id,
        ProductName: item.title,
        Quantity: item.quantity,
        ItemPrice: parseFloat(item.price.replace('$', '')),
        ProductURL: 'https://www.beckywexlin.com/' + (item.slug || item.id || ''),
        ImageURL: item.image || ''
      };
    });
    var klaviyoTotal = cart.reduce(function(sum, item) {
      return sum + parseFloat(item.price.replace('$', '')) * item.quantity;
    }, 0);
    var checkoutProps = {
      '$event_id': 'checkout_' + Date.now(),
      '$value': klaviyoTotal,
      'ItemNames': cart.map(function(item) { return item.title; }),
      'CheckoutURL': window.location.href,
      'Items': klaviyoItems
    };
    if (savedPromo) {
      checkoutProps.DiscountCode = savedPromo;
    }
    _learnq.push(['track', 'Started Checkout', checkoutProps]);
  }

  // Klaviyo — identify user when email is entered
  var emailInput = document.getElementById('email');
  if (emailInput) {
    emailInput.addEventListener('blur', function() {
      var email = emailInput.value.trim();
      if (email && email.includes('@')) {
        var _learnq = window._learnq || [];
        _learnq.push(['identify', { '$email': email }]);
      }
    });
  }

  await initStripe();
  const clientSecret = await createPaymentIntent(cart, 0);
  await mountPaymentElement(clientSecret);
  // After the Payment Element, so `elements` exists. Wrapped because a wallet
  // failure must never take the card form down with it.
  try {
    await mountExpressCheckout();
  } catch (e) {
    console.error('express checkout unavailable:', e && e.message);
  }

  // Handle form submit
  const form = document.getElementById('checkout-form');
  if (form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();

      const shipping = {
        firstName: document.getElementById('first-name').value,
        lastName: document.getElementById('last-name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        address1: document.getElementById('address1').value,
        address2: document.getElementById('address2').value,
        city: document.getElementById('city').value,
        state: document.getElementById('state').value,
        zip: document.getElementById('zip').value,
        country: document.getElementById('country').value || 'US'
      };

      // Validate fields
let valid = true;
document.querySelectorAll('#checkout-form [required]').forEach(field => {
  const group = field.closest('.checkout-form-group') || field.closest('.field');
  if (!field.value.trim() || !field.checkValidity()) {
    if (group) group.classList.add('has-error');
    field.style.borderColor = 'var(--pink)';
    valid = false;
  } else {
    if (group) group.classList.remove('has-error');
    field.style.borderColor = '';
  }
});

const country = document.getElementById('country').value || 'US';

// Restricted destination — stop before any charge is attempted.
if (window.BW_SHIPPING && window.BW_SHIPPING.isBlocked(country)) {
  showBlockedCountryNotice(country);
  return;
}

const mark = (el, ok) => {
  const group = el.closest('.checkout-form-group') || el.closest('.field');
  if (group) group.classList.toggle('has-error', !ok);
  el.style.borderColor = ok ? '' : 'var(--pink)';
  if (!ok) valid = false;
};

// ZIP: strict format for the US, any non-empty value elsewhere, and skipped
// entirely for the ~60 countries that have no postal code system.
const zip = document.getElementById('zip');
const zipVal = zip.value.trim();
if (country === 'US') {
  mark(zip, /^\d{5}(-\d{4})?$/.test(zipVal));
} else if (window.BW_SHIPPING && !window.BW_SHIPPING.needsPostal(country)) {
  mark(zip, true);
} else {
  mark(zip, !!zipVal);
}

// State / province: required only where carriers actually demand one.
const state = document.getElementById('state');
const stateVal = state.value.trim();
if (country === 'US') {
  mark(state, /^[A-Za-z]{2}$/.test(stateVal));
} else if (window.BW_SHIPPING && window.BW_SHIPPING.needsRegion(country)) {
  mark(state, !!stateVal);
} else {
  mark(state, true);
}

      if (!valid) return;

      localStorage.setItem('bw-shipping', JSON.stringify(shipping));

      const btn = document.getElementById('checkout-submit');
      clearCheckoutError();
      btn.textContent = 'Processing...';
      btn.disabled = true;

      // Ensure tax is calculated before payment
      await calculateTax();

      // Update payment intent with final amount including tax. The worker
      // re-checks the destination here — the last point a restricted order can
      // be refused before the card is charged.
      const piRes = await fetch(CHECKOUT_WORKER + '/update-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          tax: currentTaxAmount,
          taxCalculationId,
          paymentIntentId: currentPaymentIntentId,
          promoCode: currentPromoCode,
          country: shipping.country
        })
      });

      if (piRes.status === 403) {
        const body = await piRes.json().catch(() => ({}));
        if (body.blocked) {
          const msg = document.getElementById('blocked-country-message');
          if (msg && body.message) msg.textContent = body.message;
          showBlockedCountryNotice(shipping.country);
          // Returning without restoring the button left it disabled on
          // "Processing..." forever, so the page looked hung.
          btn.textContent = 'Place order';
          btn.disabled = false;
          return;
        }
      }

      // Any other non-OK response here means the amount was never updated, so
      // charging would take the wrong total. Stop rather than proceed.
      if (!piRes.ok) {
        showCheckoutError('We could not finalise your total. Please try again in a moment.');
        btn.textContent = 'Place order';
        btn.disabled = false;
        return;
      }

      const success = await submitOrder(shipping);
      if (!success) {
        btn.textContent = 'Place order';
        btn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', initCheckout);