const express = require('express');
const db = require('../db/pool');
const { createCheckout, handleWebhook, createPortalSession, PLANS } = require('./stripe');
const crypto = require('crypto');

const router = express.Router();

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Auth routes ---
router.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');

  try {
    await db.query(`
      INSERT INTO subscribers (email, password_hash, salt, tier, status, digest_frequency, created_at)
      VALUES ($1, $2, $3, 'free', 'active', 'weekly', NOW())
    `, [email, hash, salt]);

    req.session.user = { email, tier: 'free' };
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await db.query('SELECT * FROM subscribers WHERE email = $1', [email]);
  if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

  const user = rows[0];
  const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = { email: user.email, tier: user.tier, id: user.id };
  res.json({ success: true, redirect: '/dashboard' });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, redirect: '/' });
});

// --- Lead routes ---
router.get('/leads', requireAuth, async (req, res) => {
  const { min_score = 30, zip, type, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const params = [parseInt(min_score)];
  let where = 'WHERE l.score >= $1';

  if (zip) {
    params.push(zip);
    where += ` AND p.property_zip = $${params.length}`;
  }
  if (type) {
    params.push(type);
    where += ` AND l.lead_type = $${params.length}`;
  }

  // Free tier: only show top 3 leads
  const userLimit = req.session.user.tier === 'free' ? 3 : parseInt(limit);

  params.push(userLimit);
  params.push(offset);

  const { rows } = await db.query(`
    SELECT l.*, p.property_address, p.property_city, p.property_zip, p.property_type,
           p.assessed_value, p.market_value, p.owner_name, p.bedrooms, p.bathrooms, p.sqft,
           p.owner_state, p.tax_delinquent
    FROM leads l
    JOIN properties p ON l.parcel_id = p.parcel_id
    ${where}
    ORDER BY l.score DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const { rows: [{ count }] } = await db.query(`
    SELECT COUNT(*) FROM leads l JOIN properties p ON l.parcel_id = p.parcel_id ${where}
  `, params.slice(0, -2));

  res.json({
    leads: rows,
    total: parseInt(count),
    page: parseInt(page),
    pages: Math.ceil(count / userLimit),
    tier: req.session.user.tier,
  });
});

router.get('/leads/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(`
    SELECT l.*, p.*
    FROM leads l
    JOIN properties p ON l.parcel_id = p.parcel_id
    WHERE l.id = $1
  `, [req.params.id]);

  if (rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
  res.json(rows[0]);
});

// --- Stats ---
router.get('/stats', requireAuth, async (req, res) => {
  const [leads, properties, foreclosures] = await Promise.all([
    db.query('SELECT COUNT(*) as total, AVG(score) as avg_score FROM leads'),
    db.query('SELECT COUNT(*) as total FROM properties'),
    db.query('SELECT COUNT(*) as total FROM foreclosures WHERE status = $1', ['scheduled']),
  ]);

  res.json({
    leads: { total: parseInt(leads.rows[0].total), avgScore: Math.round(leads.rows[0].avg_score || 0) },
    properties: parseInt(properties.rows[0].total),
    upcomingForeclosures: parseInt(foreclosures.rows[0].total),
  });
});

// --- Subscriber settings ---
router.get('/settings', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM subscribers WHERE email = $1', [req.session.user.email]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const user = rows[0];
  res.json({
    email: user.email,
    tier: user.tier,
    zip_codes: user.zip_codes,
    min_score: user.min_score,
    digest_frequency: user.digest_frequency,
  });
});

router.put('/settings', requireAuth, async (req, res) => {
  const { zip_codes, min_score, digest_frequency } = req.body;

  await db.query(`
    UPDATE subscribers SET zip_codes = $1, min_score = $2, digest_frequency = $3
    WHERE email = $4
  `, [zip_codes || [], min_score || 30, digest_frequency || 'daily', req.session.user.email]);

  res.json({ success: true });
});

// --- Stripe routes ---
router.post('/checkout', requireAuth, async (req, res) => {
  const { tier } = req.body;
  try {
    const session = await createCheckout(req.session.user.email, tier);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

router.post('/portal', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT stripe_customer_id FROM subscribers WHERE email = $1', [req.session.user.email]);
  if (!rows[0]?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });

  const session = await createPortalSession(rows[0].stripe_customer_id);
  res.json({ url: session.url });
});

// --- Plans info (public) ---
router.get('/plans', (req, res) => {
  res.json(PLANS);
});

// --- Admin: trigger scrape/scoring (protected by secret) ---
router.post('/admin/scrape', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.SESSION_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { action } = req.body;
  try {
    if (action === 'vcpa') {
      const { runFullScrape } = require('../scrapers/vcpa');
      const result = await runFullScrape();
      return res.json({ success: true, action: 'vcpa', result });
    }
    if (action === 'score') {
      const { runScoringEngine } = require('../scoring/engine');
      const result = await runScoringEngine(20);
      return res.json({ success: true, action: 'score', result });
    }
    if (action === 'prospects') {
      const { findProspects } = require('../prospector/finder');
      const result = await findProspects();
      return res.json({ success: true, action: 'prospects', count: result.length });
    }
    return res.status(400).json({ error: 'Unknown action. Use: vcpa, score, prospects' });
  } catch (err) {
    console.error('Admin scrape error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/migrate', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.SESSION_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await db.query('ALTER TABLE properties ALTER COLUMN assessed_value TYPE BIGINT');
    await db.query('ALTER TABLE properties ALTER COLUMN market_value TYPE BIGINT');
    await db.query('ALTER TABLE properties ALTER COLUMN taxable_value TYPE BIGINT');
    await db.query('ALTER TABLE properties ALTER COLUMN last_sale_price TYPE BIGINT');
    await db.query('ALTER TABLE ownership_changes ALTER COLUMN sale_price TYPE BIGINT');
    res.json({ success: true, message: 'Migration successful' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
