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
  return data.clientSecret;
}

// ── MOUNT PAYMENT ELEMENT ──
async function mountPaymentElement(clientSecret) {
  elements = stripe.elements({ clientSecret });
  paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');
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

// ── SUBMIT ORDER ──
async function submitOrder(shipping) {
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
    return false;
  }

  // Send order to Printify via worker
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');

  // Read GA4 client_id so the worker can attribute the server-side purchase event
  let gaClientId = '';
  try {
    const gaCookie = document.cookie.split('; ').find(c => c.startsWith('_ga='));
    if (gaCookie) {
      // _ga=GA1.1.123456789.1234567890 → "123456789.1234567890"
      const parts = gaCookie.split('.');
      gaClientId = parts.slice(2).join('.');
    }
  } catch (e) {}

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
          return;
        }
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