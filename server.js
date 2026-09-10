require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

// .trim() guards against a stray trailing newline/whitespace from copy-pasting the
// key into a dashboard env var field — that's invisible but breaks the HTTP client.
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
const gmailUser = (process.env.GMAIL_USER || '').trim();
const gmailAppPassword = (process.env.GMAIL_APP_PASSWORD || '').trim();

if (!stripeSecretKey) {
  console.warn('Missing STRIPE_SECRET_KEY — the site will run, but checkout will fail until it is set.');
}
if (!gmailUser || !gmailAppPassword) {
  console.warn('Missing GMAIL_USER/GMAIL_APP_PASSWORD — the site will run, but the contact form will fail until they are set.');
}

const stripe = Stripe(stripeSecretKey || 'sk_test_placeholder_key_not_set');
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: gmailUser, pass: gmailAppPassword },
});
const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pricing.json'), 'utf8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
      // We build line items dynamically (price_data) rather than from pre-registered
      // Stripe Products, so they have no tax_code — Managed Payments requires one.
      managed_payments: { enabled: false },
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

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are all required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    await mailer.sendMail({
      from: `UniPath Website <${gmailUser}>`,
      to: gmailUser,
      replyTo: email,
      subject: `New message from ${name} via unipathedu.org`,
      text: `From: ${name} <${email}>\n\n${message}`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('contact form error:', err.message);
    res.status(400).json({ error: 'Could not send your message. Please try again or email us directly.' });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`UniPath running at http://localhost:${PORT}`);
});
