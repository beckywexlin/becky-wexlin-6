/* ============================================
   BECKY WEXLIN CREATIVE — Checkout Worker
   Cloudflare Worker with Stripe + Printify + Tax
   ============================================ */

const PRINTIFY_BASE = 'https://api.printify.com/v1';
const SHOP_ID = '26790889';
const KLAVIYO_COMPANY_ID = 'SSfm5P';
const KLAVIYO_REVISION = '2024-10-15';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── RESTRICTED DESTINATIONS ───────────────────────────────────────────────
// Trade restrictions mean our print partners cannot fulfil to these. The
// browser also knows this list (js/shipping-countries.js) so the customer gets
// told early — but that copy is a courtesy and can be edited by anyone with
// devtools, so this is the enforcement. KEEP THE TWO LISTS IN SYNC.
//
// Ukraine is blocked as a whole country, which subsumes the separately
// restricted Crimea, Donetsk and Luhansk regions.
const BLOCKED_COUNTRIES = {
  CU: 'Cuba',
  IR: 'Iran',
  KP: 'North Korea',
  UA: 'Ukraine (incl. Crimea, Donetsk and Luhansk)',
  RU: 'Russia',
  BY: 'Belarus',
  PS: 'Palestine (Gaza Strip)',
  SY: 'Syria',
};

function isBlockedCountry(code) {
  return Object.prototype.hasOwnProperty.call(
    BLOCKED_COUNTRIES, String(code || '').trim().toUpperCase());
}

// Single wording for every refusal path so the customer never sees two
// different explanations for the same thing.
function blockedResponse(code) {
  const name = BLOCKED_COUNTRIES[String(code || '').trim().toUpperCase()] || 'that destination';
  return json({
    error: 'destination_not_supported',
    blocked: true,
    country: String(code || '').trim().toUpperCase(),
    message: `Sorry — we're unable to ship to ${name}. Trade restrictions mean our `
      + `print partners can't fulfil orders to this destination. If you have another `
      + `delivery address we'd love your order, or email hello@beckywexlin.com and we'll help.`,
  }, 403);
}

// Calculate subtotal in cents from cart items
// The catalog is the only trustworthy source of a price. Everything below used
// to read item.price straight out of the request body, which meant the amount
// charged was whatever the browser claimed — a shirt could be bought for a cent
// by editing one number before submitting.
const CATALOG_URL = 'https://becky-wexlin-api.beckywexlin.workers.dev/api/products';

async function catalogPrices() {
  // Cached at the edge by the API worker already; this second cache just keeps
  // a checkout from paying that latency on every one of its three calls.
  const cache = caches.default;
  const key = new Request(CATALOG_URL, { method: 'GET' });
  let res = await cache.match(key);
  if (!res) {
    res = await fetch(CATALOG_URL);
    if (!res.ok) return null;
    const store = new Response(res.clone().body, res);
    store.headers.set('Cache-Control', 'public, max-age=300');
    await cache.put(key, store);
  }
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.products)) return null;
  const map = new Map();
  for (const prod of data.products) {
    const cents = Math.round(parseFloat(String(prod.price).replace('$', '')) * 100);
    if (prod.id && Number.isFinite(cents)) map.set(String(prod.id), cents);
  }
  return map.size ? map : null;
}

// Returns { cents } or { error }. A missing product is refused rather than
// priced at zero — silently dropping a line item is how you ship for free.
function pricedSubtotal(items, priceMap) {
  if (!Array.isArray(items) || !items.length) return { error: 'Cart is empty' };
  let cents = 0;
  for (const item of items) {
    const unit = priceMap.get(String(item.id));
    if (unit === undefined) return { error: `Unknown product: ${item.id}` };
    const qty = Number(item.quantity) || 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 25) {
      return { error: 'Invalid quantity' };
    }
    cents += unit * qty;
  }
  return { cents };
}

// Kept for the Klaviyo payload, which reports what the shopper saw. Never used
// to decide what to charge.
function subtotalCents(items) {
  return items.reduce((sum, item) => {
    const price = typeof item.price === 'string'
      ? parseFloat(item.price.replace('$', ''))
      : item.price;
    return sum + Math.round(price * 100) * (item.quantity || 1);
  }, 0);
}

// Helper: call Stripe API via fetch
async function stripeAPI(env, method, endpoint, params) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) {
    opts.body = buildFormBody(params);
  }
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, opts);
  return res.json();
}

// Convert nested object to Stripe's form-encoded format
function buildFormBody(obj, prefix) {
  const parts = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      parts.push(buildFormBody(val, fullKey));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(buildFormBody(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (val !== null && val !== undefined) {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(val)}`);
    }
  }
  return parts.join('&');
}

async function klaviyoIdentify(email, firstName, lastName, source) {
  await fetch(`https://a.klaviyo.com/client/profiles/?company_id=${KLAVIYO_COMPANY_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'revision': KLAVIYO_REVISION },
    body: JSON.stringify({
      data: {
        type: 'profile',
        attributes: {
          email,
          first_name: firstName || '',
          last_name: lastName || '',
          properties: { source },
        },
      },
    }),
  });
}

async function klaviyoPlacedOrder(email, firstName, lastName, items, orderId, shipping, taxAmount, promoCode, discountAmount) {
  const total = items.reduce((sum, item) => {
    const price = typeof item.price === 'string'
      ? parseFloat(item.price.replace('$', ''))
      : item.price;
    return sum + price * (item.quantity || 1);
  }, 0);

  const discount = discountAmount || 0;
  const orderDate = new Date().toISOString();

  await fetch(`https://a.klaviyo.com/client/events/?company_id=${KLAVIYO_COMPANY_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'revision': KLAVIYO_REVISION },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: 'Placed Order' } } },
          profile: { data: { type: 'profile', attributes: { email, first_name: firstName || '', last_name: lastName || '' } } },
          properties: {
            order_id: orderId,
            order_date: orderDate,
            subtotal: total.toFixed(2),
            discount_code: promoCode || '',
            discount_amount: discount.toFixed(2),
            value: (total - discount + (taxAmount || 0)).toFixed(2),
            tax: (taxAmount || 0).toFixed(2),
            items: items.map(item => ({
              name: item.title || item.name || '',
              quantity: item.quantity || 1,
              price: typeof item.price === 'string' ? parseFloat(item.price.replace('$', '')) : item.price,
              image: item.image || '',
              size: item.size || '',
            })),
            shipping_address: {
              name: (shipping.firstName || '') + ' ' + (shipping.lastName || ''),
              address1: shipping.address1 || '',
              address2: shipping.address2 || '',
              city: shipping.city || '',
              state: shipping.state || '',
              zip: shipping.zip || '',
              country: shipping.country || 'US',
            },
          },
          value: total - discount,
        },
      },
    }),
  });
}

// ── PROMO CODES ──
// This file was served publicly at /checkout-worker.js until 2026-08-10 —
// the assets directory is the repo root and this file wasn't in .assetsignore,
// so anything in this table was readable by anyone. It's shielded now, but
// treat every code below as already public and give high-value ones an expiry.
const PROMO_CODES = {
  'WELCOME10':        { type: 'percent', value: 10 },
  'GOLETA10':         { type: 'percent', value: 10 },
  // IAMATOTALGEEBAG (100% off, contest winners) removed 2026-08-16 — all
  // winners have redeemed. It was readable by anyone while this file was served
  // publicly, so it is deleted rather than expired: an unknown number of people
  // hold it, and free orders no longer cost a redeemer even the 50c Stripe
  // floor. Do not re-add this string; issue a fresh code if another giveaway
  // runs.
};

function applyPromo(code, subtotalCents) {
  const promo = PROMO_CODES[(code || '').toUpperCase().trim()];
  if (!promo) return { valid: false, discount: 0 };
  // Inclusive of the final day — a code dated 2026-09-07 stops working at
  // midnight UTC that night.
  if (promo.expires && Date.now() > Date.parse(promo.expires + 'T23:59:59Z')) {
    return { valid: false, discount: 0, expired: true };
  }
  if (promo.type === 'percent') {
    const discount = Math.round(subtotalCents * promo.value / 100);
    return { valid: true, discount, label: `${promo.value}% off` };
  }
  if (promo.type === 'fixed') {
    const discount = Math.min(promo.value, subtotalCents);
    return { valid: true, discount, label: `$${(promo.value / 100).toFixed(2)} off` };
  }
  return { valid: false, discount: 0 };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── GET /config ──
    if (pathname === '/config') {
      return json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY });
    }

    // ── POST /validate-promo ──
    // ── Apple Pay domain registration ────────────────────────────────────
    // automatic_payment_methods is already on and the Payment Element shows
    // wallets by default, so nothing in the checkout code was stopping Apple
    // Pay — Stripe simply refuses to render it until the domain is registered
    // and verified. That is an API call, not a dashboard-only action, so it can
    // be done from here. Google Pay needs no domain step.
    if (pathname === '/admin/payment-domains') {
      if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY not configured' }, 503);
      const given = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
      if (given !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);

      if (req.method === 'GET') {
        const r = await stripeAPI(env, 'GET', '/payment_method_domains');
        const rows = (r.data || []).map(d => ({
          id: d.id,
          domain: d.domain_name,
          enabled: d.enabled,
          apple_pay: d.apple_pay && d.apple_pay.status,
          google_pay: d.google_pay && d.google_pay.status,
          link: d.link && d.link.status,
        }));
        return json(rows.length ? rows : { none_registered: true });
      }

      if (req.method === 'POST') {
        const domain = url.searchParams.get('domain');
        if (!domain) return json({ error: 'domain required' }, 400);
        const created = await stripeAPI(env, 'POST', '/payment_method_domains', {
          domain_name: domain,
        });
        if (created.error) return json({ error: created.error.message }, 400);
        // Registration alone leaves it unvalidated; Stripe fetches the
        // well-known file during validation and that is what flips Apple Pay on.
        const checked = await stripeAPI(env, 'POST',
          `/payment_method_domains/${created.id}/validate`);
        return json({
          id: created.id,
          domain: created.domain_name,
          apple_pay: checked.apple_pay || (created.apple_pay || null),
          google_pay: checked.google_pay || (created.google_pay || null),
          link: checked.link || (created.link || null),
          error: checked.error ? checked.error.message : undefined,
        });
      }

      return json({ error: 'method not allowed' }, 405);
    }

    if (pathname === '/validate-promo' && req.method === 'POST') {
      const { code, items } = await req.json();
      const subtotal = subtotalCents(items);
      const result = applyPromo(code, subtotal);
      return json({
        valid: result.valid,
        discount: result.discount / 100,
        label: result.label || '',
      });
    }

    // ── POST /create-payment-intent ──
    if (pathname === '/create-payment-intent' && req.method === 'POST') {
      const { items, tax, promoCode } = await req.json();
      const priceMap1 = await catalogPrices();
      if (!priceMap1) return json({ error: 'Pricing unavailable, please retry' }, 503);
      const priced1 = pricedSubtotal(items, priceMap1);
      if (priced1.error) return json({ error: priced1.error }, 400);
      const subtotal = priced1.cents;
      const promo = applyPromo(promoCode, subtotal);
      const taxCents = Math.round((tax || 0) * 100);
      const amount = Math.max(subtotal - promo.discount + taxCents, 50);

      const pi = await stripeAPI(env, 'POST', '/payment_intents', {
        amount,
        currency: 'usd',
        automatic_payment_methods: { enabled: 'true' },
      });

      return json({
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
      });
    }

    // ── POST /calculate-tax ──
    if (pathname === '/calculate-tax' && req.method === 'POST') {
      const { items, address } = await req.json();

      // Earliest point we see a country. Refusing here means the customer is
      // told while filling the form rather than at the payment step.
      if (isBlockedCountry(address && address.country)) {
        return blockedResponse(address.country);
      }

      try {
        // Build line_items for Stripe Tax Calculation
        const lineItems = items.map((item, i) => {
          const price = typeof item.price === 'string'
            ? parseFloat(item.price.replace('$', ''))
            : item.price;
          const amount = Math.round(price * 100) * (item.quantity || 1);
          return {
            amount,
            reference: item.id || item.variantId || `item-${i}`,
            tax_code: 'txcd_99999999',
          };
        });

        const params = {
          currency: 'usd',
          customer_details: {
            address: {
              line1: address.line1 || '',
              city: address.city || '',
              state: address.state || '',
              postal_code: address.postal_code || '',
              country: address.country || 'US',
            },
            address_source: 'shipping',
          },
          line_items: lineItems,
        };

        const taxCalc = await stripeAPI(env, 'POST', '/tax/calculations', params);

        if (taxCalc.error) {
          console.error('Stripe Tax error:', taxCalc.error.message);
          return json({ tax_amount: 0, error: taxCalc.error.message });
        }

        return json({
          tax_amount: taxCalc.tax_amount_exclusive / 100,
          tax_calculation_id: taxCalc.id,
        });
      } catch (err) {
        console.error('Tax calculation error:', err.message);
        return json({ tax_amount: 0, error: err.message });
      }
    }

    // ── POST /update-payment-intent ──
    if (pathname === '/update-payment-intent' && req.method === 'POST') {
      const { items, tax, taxCalculationId, paymentIntentId, promoCode, country } = await req.json();

      // This runs immediately before stripe.confirmPayment, so it is the last
      // gate that can stop a restricted order WITHOUT having taken money first.
      if (isBlockedCountry(country)) {
        return blockedResponse(country);
      }

      const priceMap2 = await catalogPrices();
      if (!priceMap2) return json({ error: 'Pricing unavailable, please retry' }, 503);
      const priced2 = pricedSubtotal(items, priceMap2);
      if (priced2.error) return json({ error: priced2.error }, 400);
      const subtotal = priced2.cents;
      const promo = applyPromo(promoCode, subtotal);
      const taxCents = Math.round((tax || 0) * 100);
      const due = subtotal - promo.discount + taxCents;
      const amount = Math.max(due, 50);

      try {
        const result = await stripeAPI(env, 'POST', `/payment_intents/${paymentIntentId}`, {
          amount,
          metadata: {
            tax_amount_cents: String(taxCents),
            tax_calculation_id: taxCalculationId || '',
            // Stamped on the intent so /create-order can check the charge
            // against a figure Stripe holds, not one the browser resends.
            expected_amount_cents: String(amount),
          },
        });

        if (result.error) {
          return json({ error: result.error.message }, 400);
        }
        return json({ success: true });
      } catch (err) {
        console.error('Update payment intent error:', err.message);
        return json({ error: err.message }, 400);
      }
    }

    // ── POST /create-order ──
    if (pathname === '/create-order' && req.method === 'POST') {
      const { items, shipping, paymentIntentId, promoCode, gaClientId } = await req.json();

      // Backstop. Reaching here with a blocked country means the earlier gates
      // were bypassed, so the payment may already have succeeded — refuse to
      // send it to Printify and flag it loudly for a manual refund rather than
      // taking money for an order that can never ship.
      if (isBlockedCountry(shipping && shipping.country)) {
        console.error(
          'BLOCKED DESTINATION reached /create-order — refund required.',
          'paymentIntentId=', paymentIntentId,
          'country=', shipping && shipping.country
        );
        return blockedResponse(shipping && shipping.country);
      }

      // ── Payment verification ──────────────────────────────────────────
      // Nothing here previously asked Stripe whether the money arrived. The
      // browser supplied a paymentIntentId and this endpoint took it on trust,
      // so a POST with any string and any cart printed and shipped real goods
      // at our expense. Every order is now checked against Stripe before
      // anything reaches Printify.
      const priceMap = await catalogPrices();
      if (!priceMap) return json({ error: 'Pricing unavailable, please retry' }, 503);
      const priced = pricedSubtotal(items, priceMap);
      if (priced.error) return json({ error: priced.error }, 400);
      const orderPromo = applyPromo(promoCode, priced.cents);
      const dueCents = priced.cents - orderPromo.discount;

      if (dueCents > 0) {
        if (!paymentIntentId || !/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId))) {
          return json({ error: 'Missing payment' }, 402);
        }
        const piRes = await stripeAPI(env, 'GET', `/payment_intents/${paymentIntentId}`);
        if (piRes.error || !piRes.id) {
          return json({ error: 'Payment could not be verified' }, 402);
        }
        if (piRes.status !== 'succeeded') {
          return json({ error: `Payment not completed (${piRes.status})` }, 402);
        }
        // amount_received is what Stripe actually captured. Comparing against
        // the amount we intended to charge stops a stale or tampered intent
        // from covering a larger cart.
        const received = Number(piRes.amount_received || 0);
        const expected = Number(piRes.metadata?.expected_amount_cents || piRes.amount || 0);
        if (received < expected || received < Math.max(dueCents, 50)) {
          console.error('UNDERPAID ORDER refused', paymentIntentId, received, expected, dueCents);
          return json({ error: 'Payment amount mismatch' }, 402);
        }
      } else {
        // A genuinely free order. Stripe cannot charge zero, so this used to be
        // floored at 50 cents: a "100% off" code quietly took real money and
        // the confirmation email still said $0.00. With the promo validated
        // server-side there is nothing to charge, so no intent is created.
        console.log('FREE ORDER via promo', promoCode || '(none)', 'items', items.length);
        if (!orderPromo.valid || orderPromo.discount < priced.cents) {
          return json({ error: 'Order total could not be verified' }, 402);
        }
      }

      const line_items = items.map(item => ({
        product_id: item.id,
        variant_id: typeof item.variantId === 'number'
          ? item.variantId
          : parseInt(item.variantId, 10),
        quantity: item.quantity || 1,
      }));

      const orderBody = {
        // Printify rejects a duplicate external_id, which doubles as the replay
        // guard: the same payment intent cannot produce two orders.
        external_id: paymentIntentId || `free_${promoCode || 'promo'}_${shipping.email}`,
        line_items,
        shipping_method: 1,
        address_to: {
          first_name: shipping.firstName,
          last_name: shipping.lastName,
          email: shipping.email,
          phone: shipping.phone || '',
          address1: shipping.address1,
          address2: shipping.address2 || '',
          city: shipping.city,
          region: shipping.state,
          zip: shipping.zip,
          country: shipping.country || 'US',
        },
      };

      const res = await fetch(
        `${PRINTIFY_BASE}/shops/${SHOP_ID}/orders.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.PRINTIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(orderBody),
        }
      );

      const body = await res.json();
      if (!res.ok) {
        console.error('Printify order error:', JSON.stringify(body));
        return json({ error: 'Order failed', detail: body }, res.status);
      }

      // Fire Klaviyo profile + Placed Order event server-side
      const promo = applyPromo(promoCode, subtotalCents(items));
      try {
        await Promise.all([
          klaviyoIdentify(shipping.email, shipping.firstName, shipping.lastName, 'Checkout — Order Placed'),
          klaviyoPlacedOrder(shipping.email, shipping.firstName, shipping.lastName, items, paymentIntentId, shipping, 0, promoCode || '', promo.discount / 100),
        ]);
      } catch (e) {
        console.error('Klaviyo error:', e.message);
      }

      // GA4 Measurement Protocol — server-side purchase event (survives closed
      // tabs, ad blockers, and redirect-based payment methods). Requires
      // GA4_API_SECRET set via `wrangler secret put GA4_API_SECRET`.
      // Both purchase paths used to depend on GA4 being loaded in the browser:
      // an ad blocker means no gtag, which means no _ga cookie, which meant no
      // gaClientId and this server-side event was skipped as well. They failed
      // together, which is why Klaviyo recorded more orders than GA4.
      //
      // A synthesized id loses campaign attribution for that order but records
      // the revenue, which is the part you cannot reconstruct later. GA4
      // deduplicates purchases by transaction_id, so this is safe alongside the
      // client-side event on /order-success.
      if (env.GA4_API_SECRET) {
        try {
          const subtotal = items.reduce((sum, item) => {
            const price = typeof item.price === 'string'
              ? parseFloat(item.price.replace('$', ''))
              : item.price;
            return sum + price * (item.quantity || 1);
          }, 0);
          const ga4Items = items.map(item => ({
            item_id: item.id,
            item_name: item.title || item.name || '',
            item_variant: item.size || '',
            price: typeof item.price === 'string'
              ? parseFloat(item.price.replace('$', ''))
              : item.price,
            quantity: item.quantity || 1,
          }));
          // GA4 wants "<random>.<timestamp>". Derived from the payment intent
          // so a retry of the same order reuses the same pseudo-user.
          let hash = 0;
          for (let i = 0; i < paymentIntentId.length; i++) {
            hash = (hash * 31 + paymentIntentId.charCodeAt(i)) >>> 0;
          }
          const fallbackClientId = `${hash}.${Math.floor(Date.now() / 1000)}`;

          const mp = {
            client_id: gaClientId || fallbackClientId,
            events: [{
              name: 'purchase',
              params: {
                transaction_id: paymentIntentId,
                value: subtotal - promo.discount / 100,
                currency: 'USD',
                shipping: 0,
                // Measurement Protocol events without this are recorded but
                // dropped from most session-scoped reports, which reads as the
                // event never arriving.
                engagement_time_msec: 1,
                items: ga4Items,
              },
            }],
          };
          if (promoCode) mp.events[0].params.coupon = promoCode;
          await fetch(
            `https://www.google-analytics.com/mp/collect?measurement_id=G-WYJNL0114K&api_secret=${env.GA4_API_SECRET}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(mp),
            }
          );
        } catch (e) {
          console.error('GA4 Measurement Protocol error:', e.message);
        }
      }

      return json({ success: true, orderId: body.id });
    }

    return json({ error: 'Not found' }, 404);
  },
};
