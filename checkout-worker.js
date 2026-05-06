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
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Calculate subtotal in cents from cart items
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

async function klaviyoPlacedOrder(email, firstName, lastName, items, orderId, shipping, taxAmount) {
  const total = items.reduce((sum, item) => {
    const price = typeof item.price === 'string'
      ? parseFloat(item.price.replace('$', ''))
      : item.price;
    return sum + price * (item.quantity || 1);
  }, 0);

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
            value: (total + (taxAmount || 0)).toFixed(2),
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
          value: total,
        },
      },
    }),
  });
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

    // ── POST /create-payment-intent ──
    if (pathname === '/create-payment-intent' && req.method === 'POST') {
      const { items, tax } = await req.json();
      const subtotal = subtotalCents(items);
      const taxCents = Math.round((tax || 0) * 100);
      const amount = subtotal + taxCents;

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
      const { items, tax, taxCalculationId, paymentIntentId } = await req.json();
      const subtotal = subtotalCents(items);
      const taxCents = Math.round((tax || 0) * 100);
      const amount = subtotal + taxCents;

      try {
        const result = await stripeAPI(env, 'POST', `/payment_intents/${paymentIntentId}`, {
          amount,
          metadata: {
            tax_amount_cents: String(taxCents),
            tax_calculation_id: taxCalculationId || '',
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
      const { items, shipping, paymentIntentId } = await req.json();

      const line_items = items.map(item => ({
        product_id: item.id,
        variant_id: typeof item.variantId === 'number'
          ? item.variantId
          : parseInt(item.variantId, 10),
        quantity: item.quantity || 1,
      }));

      const orderBody = {
        external_id: paymentIntentId,
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
      try {
        await Promise.all([
          klaviyoIdentify(shipping.email, shipping.firstName, shipping.lastName, 'Checkout — Order Placed'),
          klaviyoPlacedOrder(shipping.email, shipping.firstName, shipping.lastName, items, paymentIntentId, shipping, 0),
        ]);
      } catch (e) {
        console.error('Klaviyo error:', e.message);
      }

      return json({ success: true, orderId: body.id });
    }

    return json({ error: 'Not found' }, 404);
  },
};
