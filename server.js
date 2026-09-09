require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('Missing STRIPE_SECRET_KEY — the site will run, but checkout will fail until it is set.');
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_key_not_set');
const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pricing.json'), 'utf8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Temporary diagnostic endpoint — remove once the Stripe connectivity issue is resolved.
app.get('/api/debug-stripe', async (req, res) => {
  const result = {};

  const rawStart = Date.now();
  try {
    const r = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json();
    result.rawFetch = { ok: true, ms: Date.now() - rawStart, status: r.status, body };
  } catch (err) {
    result.rawFetch = { ok: false, ms: Date.now() - rawStart, name: err.name, message: err.message, cause: err.cause ? String(err.cause) : undefined };
  }

  const sdkStart = Date.now();
  try {
    const balance = await stripe.balance.retrieve();
    result.stripeSdk = { ok: true, ms: Date.now() - sdkStart, livemode: balance.livemode };
  } catch (err) {
    result.stripeSdk = {
      ok: false,
      ms: Date.now() - sdkStart,
      allProps: Object.getOwnPropertyNames(err).reduce((acc, k) => { acc[k] = String(err[k]); return acc; }, {}),
    };
  }

  result.nodeVersion = process.version;
  res.json(result);
});

function buildLineItems(packageId, addonIds) {
  const pkg = pricing.packages[packageId];
  if (!pkg) throw new Error('Unknown package selected.');

  const lineItems = [{
    price_data: {
      currency: 'usd',
      product_data: { name: pkg.name, description: pkg.tagline },
      unit_amount: Math.round(pkg.price * 100),
    },
    quantity: 1,
  }];

  const seen = new Set();
  for (const id of addonIds || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const addon = pricing.addons.find(a => a.id === id);
    if (!addon) throw new Error('Unknown add-on selected.');
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: addon.label },
        unit_amount: Math.round(addon.price * 100),
      },
      quantity: 1,
    });
  }

  return lineItems;
}

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { packageId, addons, student } = req.body || {};
    const s = student || {};
    const lineItems = buildLineItems(packageId, addons);
    const origin = `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: s.email || undefined,
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=true`,
      metadata: {
        packageId,
        addons: (addons || []).join(','),
        fullName: (s.fullName || '').slice(0, 200),
        phone: (s.phone || '').slice(0, 50),
        destination: s.destination || '',
        intake: s.intake || '',
        notes: (s.notes || '').slice(0, 400),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', {
      message: err.message,
      type: err.type,
      code: err.code,
      causeCode: err.cause?.code,
      causeMessage: err.cause?.message,
    });
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      customerEmail: session.customer_details ? session.customer_details.email : null,
      metadata: session.metadata,
    });
  } catch (err) {
    console.error('session lookup error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`UniPath running at http://localhost:${PORT}`);
});
