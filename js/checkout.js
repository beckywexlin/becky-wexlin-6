/* ============================================
   BECKY WEXLIN CREATIVE — Checkout
   ============================================ */

const CHECKOUT_WORKER = 'https://checkout.beckywexlin.workers.dev';

let stripe;
let elements;
let paymentElement;

// ── INIT STRIPE ──
async function initStripe() {
  const res = await fetch(CHECKOUT_WORKER + '/config');
  const { publishableKey } = await res.json();
  stripe = Stripe(publishableKey);
}

// ── CREATE PAYMENT INTENT ──
async function createPaymentIntent(items) {
  const res = await fetch(CHECKOUT_WORKER + '/create-payment-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  const { clientSecret } = await res.json();
  return clientSecret;
}

// ── MOUNT PAYMENT ELEMENT ──
async function mountPaymentElement(clientSecret) {
  elements = stripe.elements({ clientSecret });
  paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');
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
    const subtotalEl = document.getElementById('checkout-subtotal');
if (subtotalEl) subtotalEl.textContent = '$' + total;
document.getElementById('checkout-total').textContent = '$' + total;
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

    const total = cart.reduce((sum, item) => {
      return sum + parseFloat(item.price.replace('$', '')) * item.quantity;
    }, 0).toFixed(2);

    document.getElementById('checkout-subtotal').textContent = '$' + total;
    document.getElementById('checkout-total').textContent = '$' + total;
  }

  await initStripe();
  const clientSecret = await createPaymentIntent(cart);
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

      const success = await submitOrder(shipping);
      if (!success) {
        btn.textContent = 'Place order';
        btn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', initCheckout);