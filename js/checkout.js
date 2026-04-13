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

// ── KLAVIYO PROFILE CAPTURE ──
function pushToKlaviyo(email, firstName, lastName, source) {
  return fetch('https://a.klaviyo.com/client/profiles/?company_id=SSfm5P', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'revision': '2024-10-15' },
    body: JSON.stringify({
      data: {
        type: 'profile',
        attributes: {
          email: email,
          first_name: firstName || '',
          last_name: lastName || '',
          properties: { source: source }
        }
      }
    })
  }).catch(() => {});
}

// ── KLAVIYO "PLACED ORDER" EVENT ──
function pushOrderToKlaviyo(email, firstName, lastName, cart, orderId, shipping) {
  var total = cart.reduce(function(sum, item) {
    return sum + parseFloat(item.price.replace('$', '')) * item.quantity;
  }, 0);

  var today = new Date();
  var orderDate = (today.getMonth() + 1).toString().padStart(2, '0') + '/' +
    today.getDate().toString().padStart(2, '0') + '/' + today.getFullYear();

  var items = cart.map(function(item) {
    return {
      name: item.title,
      quantity: item.quantity,
      price: parseFloat(item.price.replace('$', '')),
      image: item.image || '',
      size: item.size || ''
    };
  });

  return fetch('https://a.klaviyo.com/client/events/?company_id=SSfm5P', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'revision': '2024-10-15' },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: 'Placed Order' } } },
          profile: { data: { type: 'profile', attributes: { email: email, first_name: firstName || '', last_name: lastName || '' } } },
          properties: {
            order_id: orderId,
            order_date: orderDate,
            subtotal: total.toFixed(2),
            value: (total + currentTaxAmount).toFixed(2),
            tax: currentTaxAmount.toFixed(2),
            items: items,
            shipping_address: {
              name: (shipping.firstName || '') + ' ' + (shipping.lastName || ''),
              address1: shipping.address1 || '',
              address2: shipping.address2 || '',
              city: shipping.city || '',
              state: shipping.state || '',
              zip: shipping.zip || '',
              country: shipping.country || 'US'
            }
          },
          value: total
        }
      }
    })
  }).catch(() => {});
}

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
    body: JSON.stringify({ items, tax: tax || 0, taxCalculationId })
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
  const total = (subtotal + currentTaxAmount).toFixed(2);
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
      return_url: window.location.origin + '/order-success.html',
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
  await fetch(CHECKOUT_WORKER + '/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: cart,
      shipping,
      paymentIntentId: paymentIntent.id
    })
  });

  // Push customer and order event to Klaviyo (await to ensure they fire before redirect)
  try {
    await Promise.all([
      pushToKlaviyo(shipping.email, shipping.firstName, shipping.lastName, 'Checkout — Order Placed'),
      pushOrderToKlaviyo(shipping.email, shipping.firstName, shipping.lastName, cart, paymentIntent.id, shipping)
    ]);
  } catch (e) {}

  // GA4 purchase event
  if (typeof gtag === 'function') {
    const subtotal = cart.reduce((sum, item) => sum + parseFloat(item.price.replace('$', '')) * item.quantity, 0);
    gtag('event', 'purchase', {
      transaction_id: paymentIntent.id,
      value: subtotal + currentTaxAmount,
      tax: currentTaxAmount,
      currency: 'USD',
      items: cart.map(item => ({
        item_id: item.id,
        item_name: item.title,
        item_variant: item.size || '',
        price: parseFloat(item.price.replace('$', '')),
        quantity: item.quantity
      }))
    });
  }

  localStorage.removeItem('bw-cart');
  localStorage.removeItem('bw-shipping');
  window.location.href = 'order-success.html';
  return true;
}

// ── INIT CHECKOUT PAGE ──
async function initCheckout() {
  const cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');

  if (cart.length === 0 && !window.location.search.includes('payment_intent')) {
    window.location.href = 'index.html';
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
          paymentIntentId: currentPaymentIntentId
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