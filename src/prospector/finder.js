const db = require('../db/pool');

// Find potential customers from public data
// Targets: RE agents, investors, wholesalers who are active in the market
async function findProspects(limit = 50) {
  console.log('Finding new prospects from public data...');

  // Find LLC filers with RE-related businesses who aren't already prospects
  const { rows: llcProspects } = await db.query(`
    SELECT l.entity_name, l.principal_name, l.principal_address, l.filing_date
    FROM llc_filings l
    LEFT JOIN prospects p ON p.source_id = l.document_number AND p.source = 'sunbiz'
    WHERE p.id IS NULL
      AND l.category = 'real_estate'
      AND l.principal_name IS NOT NULL
    ORDER BY l.filing_date DESC
    LIMIT $1
  `, [limit]);

  // Find frequent buyers from ownership changes
  const { rows: frequentBuyers } = await db.query(`
    SELECT new_owner, COUNT(*) as purchase_count
    FROM ownership_changes
    WHERE change_date > NOW() - INTERVAL '90 days'
    GROUP BY new_owner
    HAVING COUNT(*) >= 2
    ORDER BY purchase_count DESC
    LIMIT $1
  `, [limit]);

  const prospects = [];

  for (const llc of llcProspects) {
    prospects.push({
      name: llc.principal_name,
      company: llc.entity_name,
      source: 'sunbiz',
      source_id: llc.document_number,
      address: llc.principal_address,
      prospect_type: 'llc_filer',
      notes: `Filed ${llc.entity_name} on ${llc.filing_date}`,
    });
  }

  for (const buyer of frequentBuyers) {
    const existing = await db.query(
      'SELECT id FROM prospects WHERE name = $1 AND source = $2',
      [buyer.new_owner, 'ownership_changes']
    );
    if (existing.rows.length === 0) {
      prospects.push({
        name: buyer.new_owner,
        company: null,
        source: 'ownership_changes',
        source_id: buyer.new_owner,
        address: null,
        prospect_type: 'frequent_buyer',
        notes: `${buyer.purchase_count} purchases in last 90 days`,
      });
    }
  }

  // Store prospects
  for (const p of prospects) {
    await db.query(`
      INSERT INTO prospects (name, company, source, source_id, prospect_type, notes, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT DO NOTHING
    `, [p.name, p.company, p.source, p.source_id, p.prospect_type, p.notes]);
  }

  console.log(`Found ${prospects.length} new prospects`);
  return prospects;
}

// Send outreach emails to new prospects (uses emailer module)
async function sendOutreach(prospects) {
  const { sendProspectEmail } = require('./emailer');
  let sent = 0;

  for (const prospect of prospects) {
    // Skip prospects without derivable email
    // In production, you'd use an email lookup service
    // For now, we just mark them as "needs_email"
    if (!prospect.email) {
      await db.query(
        'UPDATE prospects SET status = $1 WHERE source = $2 AND source_id = $3',
        ['needs_email', prospect.source, prospect.source_id]
      );
      continue;
    }

    try {
      await sendProspectEmail(prospect);
      await db.query(
        'UPDATE prospects SET status = $1, last_contacted = NOW() WHERE source = $2 AND source_id = $3',
        ['contacted', prospect.source, prospect.source_id]
      );
      sent++;
      await new Promise(r => setTimeout(r, 2000)); // Rate limit
    } catch (err) {
      console.error(`Failed to email ${prospect.name}:`, err.message);
    }
  }

  console.log(`Outreach complete: ${sent}/${prospects.length} emails sent`);
  return sent;
}

module.exports = { findProspects, sendOutreach };
