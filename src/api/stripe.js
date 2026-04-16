const Stripe = require('stripe');
const db = require('../db/pool');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PLANS = {
  basic: { name: 'Basic', price: 1900, interval: 'month', features: ['Weekly digest', '1 zip code', 'Email alerts'] },
  pro: { name: 'Pro', price: 3900, interval: 'month', features: ['Daily digest', 'All Volusia zips', 'Email + dashboard', 'CSV export'] },
  premium: { name: 'Premium', price: 6900, interval: 'month', features: ['Daily digest', 'Multi-county', 'API access', 'CSV export', 'Priority alerts'] },
};

// Create or get Stripe price IDs (run once during setup)
async function ensurePrices() {
  const prices = {};
  for (const [tier, plan] of Object.entries(PLANS)) {
    const existing = await getStripe().prices.search({
      query: `metadata["tier"]:"${tier}" active:"true"`,
    });

    if (existing.data.length > 0) {
      prices[tier] = existing.data[0].id;
    } else {
      const product = await getStripe().products.create({
        name: `RealCatch ${plan.name}`,
        metadata: { tier },
      });
      const price = await getStripe().prices.create({
        product: product.id,
        unit_amount: plan.price,
        currency: 'usd',
        recurring: { interval: plan.interval },
        metadata: { tier },
      });
      prices[tier] = price.id;
    }
  }
  return prices;
}

// Create checkout session
async function createCheckout(email, tier) {
  const plan = PLANS[tier];
  if (!plan) throw new Error(`Invalid tier: ${tier}`);

  const prices = await ensurePrices();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: email,
    line_items: [{ price: prices[tier], quantity: 1 }],
    success_url: `${baseUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/signup?cancelled=true`,
    metadata: { tier, email },
  });

  return session;
}

// Handle Stripe webhooks
async function handleWebhook(rawBody, signature) {
  const event = getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { tier, email } = session.metadata;

      await db.query(`
        INSERT INTO subscribers (email, tier, stripe_customer_id, stripe_subscription_id, status, digest_frequency, created_at)
        VALUES ($1, $2, $3, $4, 'active', $5, NOW())
        ON CONFLICT (email) DO UPDATE SET
          tier = EXCLUDED.tier,
          stripe_customer_id = EXCLUDED.stripe_customer_id,
          stripe_subscription_id = EXCLUDED.stripe_subscription_id,
          status = 'active',
          digest_frequency = EXCLUDED.digest_frequency
      `, [
        email,
        tier,
        session.customer,
        session.subscription,
        tier === 'basic' ? 'weekly' : 'daily',
      ]);
      console.log(`New subscriber: ${email} (${tier})`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await db.query(
        'UPDATE subscribers SET status = $1 WHERE stripe_subscription_id = $2',
        ['cancelled', sub.id]
      );
      console.log(`Subscription cancelled: ${sub.id}`);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await db.query(
        'UPDATE subscribers SET status = $1 WHERE stripe_customer_id = $2',
        ['past_due', invoice.customer]
      );
      console.log(`Payment failed for: ${invoice.customer}`);
      break;
    }
  }

  return { received: true };
}

// Create customer portal session for managing subscription
async function createPortalSession(customerId) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/dashboard`,
  });
  return session;
}

module.exports = { createCheckout, handleWebhook, createPortalSession, PLANS };
