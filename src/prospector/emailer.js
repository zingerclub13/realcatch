const Mailgun = require('mailgun.js');
const formData = require('form-data');
const db = require('../db/pool');

const mailgun = new Mailgun(formData);

function getMailgunClient() {
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    return null;
  }
  return mailgun.client({ username: 'api', key: process.env.MAILGUN_API_KEY });
}

// Send subscriber digest emails
async function sendDigests(frequency = 'daily') {
  const mg = getMailgunClient();
  if (!mg) {
    console.log('Mailgun not configured, skipping digests');
    return 0;
  }

  const { rows: subscribers } = await db.query(
    'SELECT * FROM subscribers WHERE status = $1 AND digest_frequency = $2',
    ['active', frequency]
  );

  console.log(`Sending ${frequency} digest to ${subscribers.length} subscribers`);
  let sent = 0;

  for (const sub of subscribers) {
    try {
      const leads = await getLeadsForSubscriber(sub);
      if (leads.length === 0) continue;

      const html = buildDigestHtml(leads, sub);
      const subject = `RealCatch ${frequency === 'daily' ? 'Daily' : 'Weekly'} Intel - ${leads.length} New Lead${leads.length > 1 ? 's' : ''}`;

      await mg.messages.create(process.env.MAILGUN_DOMAIN, {
        from: `RealCatch <leads@${process.env.MAILGUN_DOMAIN}>`,
        to: [sub.email],
        subject,
        html,
      });

      await db.query(`
        INSERT INTO email_log (subscriber_id, email_type, subject, sent_at)
        VALUES ($1, $2, $3, NOW())
      `, [sub.id, 'digest', subject]);

      sent++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Failed to send digest to ${sub.email}:`, err.message);
    }
  }

  console.log(`${frequency} digests sent: ${sent}/${subscribers.length}`);
  return sent;
}

async function getLeadsForSubscriber(subscriber) {
  const interval = subscriber.digest_frequency === 'daily' ? '1 day' : '7 days';
  const minScore = subscriber.min_score || 30;

  let query = `
    SELECT l.*, p.property_address, p.property_city, p.property_zip, p.property_type,
           p.assessed_value, p.market_value, p.owner_name, p.bedrooms, p.bathrooms, p.sqft
    FROM leads l
    JOIN properties p ON l.parcel_id = p.parcel_id
    WHERE l.scored_at > NOW() - INTERVAL '${interval}'
      AND l.score >= $1
  `;
  const params = [minScore];

  // Filter by subscriber zip codes if set
  if (subscriber.zip_codes && subscriber.zip_codes.length > 0) {
    params.push(subscriber.zip_codes);
    query += ` AND p.property_zip = ANY($${params.length})`;
  }

  query += ' ORDER BY l.score DESC LIMIT 20';

  const { rows } = await db.query(query, params);
  return rows;
}

function buildDigestHtml(leads, subscriber) {
  const leadRows = leads.map(lead => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 12px;">
        <strong>${lead.property_address || 'Unknown'}</strong><br>
        <small>${lead.property_city || ''}, FL ${lead.property_zip || ''}</small>
      </td>
      <td style="padding: 12px; text-align: center;">
        <span style="background: ${lead.score >= 70 ? '#ff4444' : lead.score >= 50 ? '#ffaa00' : '#44aa44'}; color: white; padding: 4px 12px; border-radius: 12px; font-weight: bold;">
          ${lead.score}
        </span>
      </td>
      <td style="padding: 12px;">
        ${lead.ai_summary || 'No summary available'}
      </td>
      <td style="padding: 12px; text-align: right;">
        $${(lead.assessed_value || 0).toLocaleString()}
      </td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
      <div style="background: #1a1a2e; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">RealCatch Intel</h1>
        <p style="margin: 5px 0 0; opacity: 0.8;">${leads.length} new lead${leads.length > 1 ? 's' : ''} matching your criteria</p>
      </div>
      <table style="width: 100%; border-collapse: collapse; background: white;">
        <thead>
          <tr style="background: #f5f5f5;">
            <th style="padding: 10px; text-align: left;">Property</th>
            <th style="padding: 10px;">Score</th>
            <th style="padding: 10px; text-align: left;">Why</th>
            <th style="padding: 10px; text-align: right;">Value</th>
          </tr>
        </thead>
        <tbody>
          ${leadRows}
        </tbody>
      </table>
      <div style="padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; text-align: center;">
        <a href="${process.env.BASE_URL || 'https://realcatch.io'}/dashboard" style="background: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          View Dashboard
        </a>
        <p style="margin-top: 15px; font-size: 12px; color: #999;">
          ${subscriber.tier === 'free' ? 'Upgrade to Pro for daily intel on all zip codes.' : `${subscriber.tier} plan - ${subscriber.zip_codes?.length || 'all'} zip codes monitored`}
        </p>
      </div>
    </body>
    </html>
  `;
}

// Send prospect outreach email with free sample
async function sendProspectEmail(prospect) {
  const mg = getMailgunClient();
  if (!mg) throw new Error('Mailgun not configured');

  // Get a couple hot leads as a free sample
  const { rows: sampleLeads } = await db.query(
    'SELECT l.*, p.property_address, p.property_city FROM leads l JOIN properties p ON l.parcel_id = p.parcel_id ORDER BY l.score DESC LIMIT 2'
  );

  const sampleHtml = sampleLeads.map(l =>
    `<li><strong>${l.property_address}, ${l.property_city}</strong> - Score: ${l.score}/100<br><em>${l.ai_summary || ''}</em></li>`
  ).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2>Hi ${prospect.name?.split(' ')[0] || 'there'},</h2>
      <p>I noticed your recent activity in the Volusia County real estate market${prospect.company ? ` through ${prospect.company}` : ''}.</p>
      <p>We built <strong>RealCatch</strong> to help investors like you find motivated sellers before anyone else — using AI analysis of public records.</p>
      <p>Here's a free sample of what we found this week:</p>
      <ul style="line-height: 1.8;">${sampleHtml || '<li>No sample leads available yet</li>'}</ul>
      <p>We score properties on tax delinquency, absentee ownership, foreclosure proximity, and more — then send you a daily digest of the highest-scoring leads.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${process.env.BASE_URL || 'https://realcatch.io'}/signup" style="background: #4CAF50; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Start Free Trial
        </a>
      </div>
      <p style="color: #666; font-size: 13px;">Plans start at $19/mo. Cancel anytime. Reply to this email with any questions.</p>
    </body>
    </html>
  `;

  await mg.messages.create(process.env.MAILGUN_DOMAIN, {
    from: `RealCatch <hello@${process.env.MAILGUN_DOMAIN}>`,
    to: [prospect.email],
    subject: `${prospect.name?.split(' ')[0] || 'Hey'} — free sample of AI-scored real estate leads`,
    html,
  });
}

module.exports = { sendDigests, sendProspectEmail };
