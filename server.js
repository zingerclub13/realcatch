require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// Security
app.use(helmet({ contentSecurityPolicy: false }));

// Stripe webhook needs raw body — must come before JSON parser
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { handleWebhook } = require('./src/api/stripe');
  try {
    const result = await handleWebhook(req.body, req.headers['stripe-signature']);
    res.json(result);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Sessions
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'realcatch-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
const apiRoutes = require('./src/api/routes');
app.use('/api', apiRoutes);

// Page routes
app.get('/', (req, res) => {
  const host = req.hostname || '';
  // volusia.realcatch.io or volusia.localhost → Volusia-specific landing
  if (host.startsWith('volusia.') || host.startsWith('volusia-')) {
    return res.render('volusia-landing');
  }
  res.render('landing');
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('dashboard', { user: req.session.user });
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

// Health check
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', service: 'realcatch', timestamp: new Date().toISOString() });
});

// Initialize database schema and start server
async function start() {
  // Run schema init at startup (internal DB URL only available at runtime, not build)
  try {
    const db = require('./src/db/pool');
    const fs = require('fs');
    const schemaPath = path.join(__dirname, 'src', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    // Run each statement individually
    const statements = sql
      .replace(/--.*$/gm, '')  // strip SQL comments
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        await db.query(stmt);
      } catch (err) {
        if (!err.message.includes('already exists')) {
          console.error(`Schema statement failed: ${err.message}`);
        }
      }
    }
    console.log('Database schema ready');
  } catch (err) {
    console.error('DB init failed (non-fatal):', err.message);
  }

  // Start cron jobs in production
  if (process.env.NODE_ENV === 'production') {
    try {
      const { startScheduler } = require('./src/cron/scheduler');
      startScheduler();
    } catch (err) {
      console.error('Scheduler init failed (non-fatal):', err.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`RealCatch.io running on port ${PORT}`);
  });
}

start();

module.exports = app;
