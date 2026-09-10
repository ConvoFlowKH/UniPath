require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Stripe = require('stripe');

// .trim() guards against a stray trailing newline/whitespace from copy-pasting the
// key into a dashboard env var field — that's invisible but breaks the HTTP client.
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
const resendApiKey = (process.env.RESEND_API_KEY || '').trim();
const contactInboxEmail = (process.env.CONTACT_INBOX_EMAIL || 'unipatheducationkh@gmail.com').trim();
const tiktokClientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
const tiktokClientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();
const tiktokRedirectUri = (process.env.TIKTOK_REDIRECT_URI || 'https://unipathedu.org/api/tiktok/callback').trim();

if (!stripeSecretKey) {
  console.warn('Missing STRIPE_SECRET_KEY — the site will run, but checkout will fail until it is set.');
}
if (!resendApiKey) {
  console.warn('Missing RESEND_API_KEY — the site will run, but the contact form will fail until it is set.');
}
if (!tiktokClientKey || !tiktokClientSecret) {
  console.warn('Missing TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET — TikTok login/posting will fail until they are set.');
}

const stripe = Stripe(stripeSecretKey || 'sk_test_placeholder_key_not_set');
const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pricing.json'), 'utf8'));

// In-memory only — resets on redeploy/restart. If posting starts failing with an
// auth error, visit /api/tiktok/login again to reconnect.
let tiktokTokens = null; // { accessToken, refreshToken, expiresAt }
let tiktokOAuthState = null;

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Videos need to stay reachable here for a while after posting — TikTok fetches
// the URL asynchronously (PULL_FROM_URL), not at request time.
app.use('/uploads', express.static(uploadsDir));

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
    if (!resendApiKey) {
      return res.status(503).json({ error: 'The contact form is not set up yet. Please email us directly for now.' });
    }

    const { name, email, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are all required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'UniPath Website <onboarding@resend.dev>',
        to: contactInboxEmail,
        reply_to: email,
        subject: `New message from ${name} via unipathedu.org`,
        text: `From: ${name} <${email}>\n\n${message}`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resendRes.ok) {
      const body = await resendRes.json().catch(() => ({}));
      throw new Error(body.message || `Resend responded with ${resendRes.status}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('contact form error:', err.message);
    res.status(400).json({ error: 'Could not send your message. Please try again or email us directly.' });
  }
});

app.get('/api/tiktok/login', (req, res) => {
  if (!tiktokClientKey) {
    return res.status(503).send('TikTok is not configured yet.');
  }
  tiktokOAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_key: tiktokClientKey,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: tiktokRedirectUri,
    state: tiktokOAuthState,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/api/tiktok/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) throw new Error(errorDescription || error);
    if (!code || state !== tiktokOAuthState) throw new Error('Invalid or expired login attempt — please try /api/tiktok/login again.');

    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: tiktokClientKey,
        client_secret: tiktokClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: tiktokRedirectUri,
      }),
    });
    const data = await tokenRes.json();
    if (data.error) throw new Error(data.error_description || data.error);

    tiktokTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    res.send('<h1>TikTok connected</h1><p>You can close this tab.</p>');
  } catch (err) {
    console.error('tiktok callback error:', err.message);
    res.status(400).send(`<h1>TikTok connection failed</h1><p>${err.message}</p>`);
  }
});

async function getValidTiktokAccessToken() {
  if (!tiktokTokens) throw new Error('TikTok is not connected yet — visit /api/tiktok/login first.');
  if (Date.now() < tiktokTokens.expiresAt - 60000) return tiktokTokens.accessToken;

  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: tiktokClientKey,
      client_secret: tiktokClientSecret,
      grant_type: 'refresh_token',
      refresh_token: tiktokTokens.refreshToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  tiktokTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tiktokTokens.accessToken;
}

app.post('/api/tiktok/post', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No video file uploaded.');

    const caption = (req.body.caption || '').slice(0, 2200);
    const accessToken = await getValidTiktokAccessToken();
    const origin = `${req.protocol}://${req.get('host')}`;
    const videoUrl = `${origin}/uploads/${req.file.filename}`;

    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          // Required while the app is unaudited: the post is only visible to the
          // connected (sandbox) account, not published publicly. TikTok lifts this
          // once the app passes review.
          privacy_level: 'SELF_ONLY',
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      }),
    });
    const initData = await initRes.json();
    if (initData.error && initData.error.code !== 'ok') {
      throw new Error(initData.error.message || 'TikTok rejected the post request.');
    }

    res.json({ ok: true, publishId: initData.data.publish_id, videoUrl });
  } catch (err) {
    console.error('tiktok post error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tiktok/status/:publishId', async (req, res) => {
  try {
    const accessToken = await getValidTiktokAccessToken();
    const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publish_id: req.params.publishId }),
    });
    const data = await statusRes.json();
    if (data.error && data.error.code !== 'ok') throw new Error(data.error.message);
    res.json(data.data);
  } catch (err) {
    console.error('tiktok status error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`UniPath running at http://localhost:${PORT}`);
});
