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

// ── CALCULATE TAX ──
async function calculateTax() {
  const state = document.getElementById('state').value.trim();
  const zip = document.getElementById('zip').value.trim();
  const city = document.getElementById('city').value.trim();
  const country = document.getElementById('country').value || 'US';
  const address1 = document.getElementById('address1').value.trim();

  // Need at least state + zip to calculate tax
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

  await fetch(CHECKOUT_WORKER + '/create-order', {
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

const zip = document.getElementById('zip');
const zipVal = zip.value.trim();
const zipGroup = zip.closest('.checkout-form-group') || zip.closest('.field');
if (!/^\d{5}(-\d{4})?$/.test(zipVal)) {
  if (zipGroup) zipGroup.classList.add('has-error');
  zip.style.borderColor = 'var(--pink)';
  valid = false;
} else {
  if (zipGroup) zipGroup.classList.remove('has-error');
  zip.style.borderColor = '';
}

const state = document.getElementById('state');
const stateVal = state.value.trim();
const stateGroup = state.closest('.checkout-form-group') || state.closest('.field');
if (!/^[A-Za-z]{2}$/.test(stateVal)) {
  if (stateGroup) stateGroup.classList.add('has-error');
  state.style.borderColor = 'var(--pink)';
  valid = false;
} else {
  if (stateGroup) stateGroup.classList.remove('has-error');
  state.style.borderColor = '';
}

      if (!valid) return;

      localStorage.setItem('bw-shipping', JSON.stringify(shipping));

      const btn = document.getElementById('checkout-submit');
      btn.textContent = 'Processing...';
      btn.disabled = true;

      // Ensure tax is calculated before payment
      await calculateTax();

      // Update payment intent with final amount including tax
      await fetch(CHECKOUT_WORKER + '/update-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          tax: currentTaxAmount,
          taxCalculationId,
          paymentIntentId: currentPaymentIntentId,
          promoCode: currentPromoCode
        })
      });

      const success = await submitOrder(shipping);
      if (!success) {
        btn.textContent = 'Place order';
        btn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', initCheckout);