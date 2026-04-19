const db = require('../db/pool');

// Find potential customers from public data
// Targets: RE investors, LLC owners, frequent buyers active in the market
async function findProspects(limit = 50) {
  console.log('Finding new prospects from property data...');

  // Find LLC/Corp owners with multiple non-homestead properties (active investors)
  const { rows: llcOwners } = await db.query(`
    SELECT p.owner_name, COUNT(*) as property_count,
           SUM(p.assessed_value) as total_value,
           p.owner_city, p.owner_state
    FROM properties p
    LEFT JOIN prospects pr ON pr.name = p.owner_name AND pr.source = 'property_data'
    WHERE pr.id IS NULL
      AND p.owner_name ~ '(LLC|INC|CORP|LP|TRUST|HOLDINGS|INVESTMENT|PROPERTIES|REALTY)'
      AND p.homestead = FALSE
    GROUP BY p.owner_name, p.owner_city, p.owner_state
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC
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

  for (const owner of llcOwners) {
    prospects.push({
      name: owner.owner_name,
      company: owner.owner_name,
      source: 'property_data',
      source_id: owner.owner_name,
      address: [owner.owner_city, owner.owner_state].filter(Boolean).join(', '),
      prospect_type: 'multi_property_investor',
      notes: `Owns ${owner.property_count} non-homestead properties (total value: $${(owner.total_value || 0).toLocaleString()})`,
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
