/* ── STORAGE ──
   Every cart read used to touch localStorage directly. In a browser set to
   block cookies and site data — "Block All Cookies" in Safari, Lockdown Mode,
   some embedded webviews — those calls throw SecurityError rather than
   returning null. The module-level `let cart = JSON.parse(localStorage...)`
   below then threw while cart.js was still evaluating, so the cart silently
   held nothing, and on /checkout the same throw left `cart` in its temporal
   dead zone ("Cannot access 'cart' before initialization") and the payment
   form never rendered. A shopper on the site's single biggest platform — iOS
   Safari, 107 sessions last month — could not buy anything and saw no reason
   why.

   Memory is the source of truth for the page session; localStorage is
   best-effort persistence on top. Nothing here can throw. */
window.bwStore = (function () {
  var mem = {};
  return {
    get: function (k) {
      try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    },
    set: function (k, v) {
      mem[k] = String(v);
      try { localStorage.setItem(k, String(v)); } catch (e) {}
    },
    remove: function (k) {
      delete mem[k];
      try { localStorage.removeItem(k); } catch (e) {}
    },
    // True when writes actually survive a reload. Used for nothing critical —
    // it just lets callers avoid promising persistence they cannot deliver.
    persists: (function () {
      try { localStorage.setItem('__bw_t', '1'); localStorage.removeItem('__bw_t'); return true; }
      catch (e) { return false; }
    })()
  };
})();

/* ── RELATED PRODUCTS ──
   Blog posts used to show three products picked at random, so a meme post
   advertised whatever happened to shuffle to the front. The blog is where
   almost all search traffic lands (2,116 of 2,163 impressions last month) and
   product pages take 61 with no clicks, so that sidebar is the main bridge
   between the two and it was pointing nowhere in particular.

   Printify's own tags are near-useless for this ("dtg", "men's clothing", on
   nearly every item), so the haystack is title + description + tags and the
   needles are the post's own meta keywords. Whole-phrase hits score highest;
   single words are worth less and short ones are ignored so "the" and "tee"
   cannot carry a match. Returns the original order when nothing scores, which
   keeps a post with no usable keywords exactly as it was. */
window.bwRelated = function (products, terms, n) {
  var list = products || [];
  var want = (terms || [])
    .map(function (t) { return String(t || '').toLowerCase().trim(); })
    .filter(Boolean);
  if (!want.length) return list.slice(0, n);

  var STOP = { the: 1, and: 1, for: 1, with: 1, that: 1, this: 1, best: 1,
               shirt: 1, shirts: 1, tee: 1, tees: 1, 't-shirt': 1, 't-shirts': 1 };

  var scored = list.map(function (p, i) {
    var hay = [p.title, p.description, (p.tags || []).join(' ')]
      .join(' ').toLowerCase().replace(/<[^>]+>/g, ' ');
    // Single words are matched against whole tokens, not the raw string:
    // indexOf('meme') is true of "Memento", which put a memento-mori tee at the
    // top of the meme post. Multi-word phrases are specific enough to match raw.
    var tokens = {};
    var parts = hay.split(/[^a-z0-9]+/);
    for (var t = 0; t < parts.length; t++) tokens[parts[t]] = 1;

    var score = 0;
    for (var w = 0; w < want.length; w++) {
      var phrase = want[w];
      var words = phrase.split(/[^a-z0-9]+/).filter(Boolean);
      if (words.length > 1) {
        if (hay.indexOf(phrase) !== -1) { score += 3; continue; }
      } else if (words.length === 1) {
        if (words[0].length > 3 && !STOP[words[0]] && tokens[words[0]]) score += 3;
        continue;
      }
      for (var j = 0; j < words.length; j++) {
        var word = words[j];
        if (word.length > 3 && !STOP[word] && tokens[word]) score += 1;
      }
    }
    return { p: p, score: score, i: i };
  });

  if (!scored.some(function (x) { return x.score > 0; })) return list.slice(0, n);
  scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });

  // Two Printify products share the title and slug "free the aliens glitchy
  // kitty", so an unfiltered top-3 could spend two of its slots on one shirt.
  var out = [], used = {};
  for (var k = 0; k < scored.length && out.length < n; k++) {
    var item = scored[k].p;
    var key = item.slug || item.title;
    if (used[key]) continue;
    used[key] = 1;
    out.push(item);
  }
  return out;
};

/* ── IMAGE SIZING ──
   Printify's mockup host resizes on request: ?s=400 returns 12KB against 73KB
   for the untouched 1200x1200. Grid cards render at ~400px and strip thumbs at
   36px, so the full-size file was pure waste — 22 requests on /shop were still
   pulling 40KB-270KB each after the server-rendered cards were fixed, because
   the client rebuilds those grids from the API and bypassed the server's sizing.

   Lives here because cart.js is deferred on every page that renders a grid, so
   it has run by the time those render functions are called. Callers use
   `window.bwSized ? window.bwSized(u, n) : u` so a load-order surprise degrades
   to the old behaviour rather than throwing.

   product.html is the exception: it renders synchronously from embedded JSON,
   which happens before deferred scripts run, so it carries its own copy of this
   logic. Keep the two in step. */
window.bwSized = function (url, px) {
  var u = String(url || '');
  if (!u || u.indexOf('images-api.printify.com') === -1) return u;
  if (/[?&]s=\d+/.test(u)) return u;          // already sized
  return u + (u.indexOf('?') === -1 ? '?' : '&') + 's=' + px;
};

/* ============================================
   BECKY WEXLIN CREATIVE — Cart
   ============================================ */


// ── CART STATE ──
let cart = JSON.parse(window.bwStore.get('bw-cart') || '[]');

function saveCart() {
  window.bwStore.set('bw-cart', JSON.stringify(cart));
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
  const qty = product.quantity || 1;
  const existing = cart.find(i => i.id === product.id && i.variantId === product.variantId);
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.push({ ...product, quantity: qty });
  }
  // GA4 add_to_cart event
  if (typeof gtag === 'function') {
    const price = parseFloat((product.price || '0').toString().replace('$', '')) || 0;
    gtag('event', 'add_to_cart', {
      currency: 'USD',
      value: price * qty,
      items: [{
        item_id: product.id,
        item_name: product.title,
        item_variant: product.size || '',
        price: price,
        quantity: qty
      }]
    });
  }

  // Klaviyo Added to Cart event
  var _learnq = window._learnq || [];
  var klPrice = parseFloat((product.price || '0').toString().replace('$', '')) || 0;
  _learnq.push(['track', 'Added to Cart', {
    '$value': klPrice * qty,
    ProductName: product.title,
    ProductID: product.id,
    Quantity: qty,
    ItemPrice: klPrice,
    ImageURL: product.image || '',
    ProductURL: window.location.href
  }]);

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
// When storage does not persist (cookies blocked, Lockdown Mode, some
// webviews) the cart only exists in this page's memory, so navigating to
// /checkout arrived with an empty cart and bounced the shopper to the homepage.
// Carrying the lines in the link is the only route left: no storage, no
// cookies, nothing else survives a navigation. Only ids, variants and
// quantities travel — every price is still decided server-side, so this adds
// no trust in the URL that did not already exist.
function syncCheckoutLink() {
  var links = document.querySelectorAll('#cart-footer a[href^="/checkout"]');
  if (!links.length) return;
  var carry = '';
  if (!window.bwStore.persists && cart.length) {
    try {
      var lean = cart.map(function (i) {
        return [String(i.id), i.variantId == null ? '' : String(i.variantId), Number(i.quantity) || 1];
      });
      carry = '?c=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(lean)))));
    } catch (e) { carry = ''; }
  }
  links.forEach(function (a) { a.setAttribute('href', '/checkout' + carry); });
}

function renderCartItems() {
  const container = document.getElementById('cart-items');
  const footer = document.getElementById('cart-footer');
  if (!container) return;

  if (cart.length === 0) {
    container.innerHTML = '<p class="cart-empty">Your cart is empty.<br><a href="/shop" style="color:var(--lime);font-size:14px;text-decoration:underline;text-underline-offset:3px;">Add something weird →</a></p>';
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
  syncCheckoutLink();
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