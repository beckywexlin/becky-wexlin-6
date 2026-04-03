/* ============================================
   BECKY WEXLIN CREATIVE — Cart
   ============================================ */


// ── CART STATE ──
let cart = JSON.parse(localStorage.getItem('bw-cart') || '[]');

function saveCart() {
  localStorage.setItem('bw-cart', JSON.stringify(cart));
  updateCartCount();
}

function updateCartCount() {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll('.cart-count').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'flex' : 'none';
  });
}

// ── ADD TO CART ──
function addToCart(product) {
  const existing = cart.find(i => i.id === product.id && i.variantId === product.variantId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ ...product, quantity: 1 });
  }
  saveCart();
  openCart();
}

// ── REMOVE FROM CART ──
function removeFromCart(id, variantId) {
  cart = cart.filter(i => !(i.id === id && i.variantId === variantId));
  saveCart();
  renderCartItems();
}

// ── UPDATE QUANTITY ──
function updateQuantity(id, variantId, delta) {
  const item = cart.find(i => i.id === id && String(i.variantId) === String(variantId));
  if (item) {
    item.quantity += delta;
    if (item.quantity <= 0) {
      cart = cart.filter(i => !(i.id === id && String(i.variantId) === String(variantId)));
      saveCart();
      renderCartItems();
    } else {
      saveCart();
      renderCartItems();
    }
  }
}

// ── CART TOTAL ──
function cartTotal() {
  return cart.reduce((sum, item) => {
    const price = parseFloat(item.price.replace('$', ''));
    return sum + price * item.quantity;
  }, 0).toFixed(2);
}

// ── RENDER CART ITEMS ──
function renderCartItems() {
  const container = document.getElementById('cart-items');
  const footer = document.getElementById('cart-footer');
  if (!container) return;

  if (cart.length === 0) {
    container.innerHTML = '<p class="cart-empty">Your cart is empty.</p>';
    footer.style.display = 'none';
    return;
  }

  footer.style.display = 'block';
  container.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div class="cart-item-img">
        ${item.image ? `<img src="${item.image}" alt="${item.title}" />` : ''}
      </div>
      <div class="cart-item-info">
        <p class="cart-item-name">${item.title}</p>
        <p class="cart-item-variant">${item.size || ''}</p>
        <p class="cart-item-price">${item.price}</p>
        <div class="cart-item-qty">
          <button onclick="updateQuantity('${item.id}', '${item.variantId}', -1)">−</button>
          <span>${item.quantity}</span>
          <button onclick="updateQuantity('${item.id}', '${item.variantId}', 1)">+</button>
        </div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart('${item.id}', ${item.variantId})">×</button>
    </div>
  `).join('');

  document.getElementById('cart-total').textContent = '$' + cartTotal();
}

// ── OPEN / CLOSE CART ──
function openCart() {
  document.getElementById('cart-drawer').classList.add('open');
  document.getElementById('cart-overlay').classList.add('open');
  renderCartItems();
}

function closeCart() {
  document.getElementById('cart-drawer').classList.remove('open');
  document.getElementById('cart-overlay').classList.remove('open');
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', function () {
  updateCartCount();

  const overlay = document.getElementById('cart-overlay');
  if (overlay) overlay.addEventListener('click', closeCart);
});