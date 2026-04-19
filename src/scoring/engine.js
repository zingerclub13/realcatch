const OpenAI = require('openai');
const db = require('../db/pool');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Signal weights for scoring
const SIGNALS = {
  tax_delinquent: { weight: 25, label: 'Tax Delinquent' },
  tax_delinquent_multi_year: { weight: 15, label: 'Multi-Year Tax Delinquent' },
  absentee_owner: { weight: 20, label: 'Absentee Owner (Out-of-State)' },
  non_homestead: { weight: 10, label: 'Non-Homestead Property' },
  recent_ownership_change: { weight: 15, label: 'Recent Ownership Change' },
  near_foreclosure: { weight: 30, label: 'Near Foreclosure Auction' },
  price_anomaly: { weight: 20, label: 'Price Below Assessed Value' },
  vacant_land: { weight: 10, label: 'Vacant Land' },
  high_equity: { weight: 15, label: 'High Equity Potential' },
  llc_owned: { weight: 5, label: 'LLC-Owned Property' },
};

// Score a single property
async function scoreProperty(property) {
  const signals = [];
  let rawScore = 0;

  // Tax delinquent
  if (property.tax_delinquent) {
    signals.push({ signal: 'tax_delinquent', weight: SIGNALS.tax_delinquent.weight });
    rawScore += SIGNALS.tax_delinquent.weight;

    if (property.tax_delinquent_years >= 2) {
      signals.push({ signal: 'tax_delinquent_multi_year', weight: SIGNALS.tax_delinquent_multi_year.weight });
      rawScore += SIGNALS.tax_delinquent_multi_year.weight;
    }
  }

  // Absentee owner (owner state != FL, or mailing city differs from property city)
  if (property.owner_state && property.owner_state !== 'FL') {
    signals.push({ signal: 'absentee_owner', weight: SIGNALS.absentee_owner.weight });
    rawScore += SIGNALS.absentee_owner.weight;
  } else if (property.owner_city && property.property_city &&
             property.owner_city.toLowerCase() !== property.property_city.toLowerCase()) {
    signals.push({ signal: 'absentee_owner', weight: Math.round(SIGNALS.absentee_owner.weight * 0.5) });
    rawScore += Math.round(SIGNALS.absentee_owner.weight * 0.5);
  }

  // Non-homestead
  if (!property.homestead) {
    signals.push({ signal: 'non_homestead', weight: SIGNALS.non_homestead.weight });
    rawScore += SIGNALS.non_homestead.weight;
  }

  // Recent ownership change (within 90 days)
  if (property.last_sale_date) {
    const saleDate = new Date(property.last_sale_date);
    const daysSinceSale = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSale <= 90) {
      signals.push({ signal: 'recent_ownership_change', weight: SIGNALS.recent_ownership_change.weight });
      rawScore += SIGNALS.recent_ownership_change.weight;
    }
  }

  // Near foreclosure
  const foreclosure = await db.query(
    'SELECT id FROM foreclosures WHERE parcel_id = $1 AND status = $2',
    [property.parcel_id, 'scheduled']
  );
  if (foreclosure.rows.length > 0) {
    signals.push({ signal: 'near_foreclosure', weight: SIGNALS.near_foreclosure.weight });
    rawScore += SIGNALS.near_foreclosure.weight;
  }

  // Price anomaly: last sale price significantly below assessed value
  if (property.last_sale_price && property.assessed_value) {
    const ratio = property.last_sale_price / property.assessed_value;
    if (ratio < 0.7) {
      signals.push({ signal: 'price_anomaly', weight: SIGNALS.price_anomaly.weight });
      rawScore += SIGNALS.price_anomaly.weight;
    }
  }

  // Vacant land
  if (property.property_type && property.property_type.toLowerCase().includes('vacant')) {
    signals.push({ signal: 'vacant_land', weight: SIGNALS.vacant_land.weight });
    rawScore += SIGNALS.vacant_land.weight;
  }

  // LLC-owned
  if (property.owner_name && /\b(LLC|INC|CORP|LP|TRUST)\b/i.test(property.owner_name)) {
    signals.push({ signal: 'llc_owned', weight: SIGNALS.llc_owned.weight });
    rawScore += SIGNALS.llc_owned.weight;
  }

  // Normalize score to 0-100
  const maxPossible = Object.values(SIGNALS).reduce((sum, s) => sum + s.weight, 0);
  const score = Math.min(100, Math.round((rawScore / maxPossible) * 100));

  // Determine lead type
  let leadType = 'general';
  if (signals.some(s => s.signal === 'near_foreclosure')) leadType = 'foreclosure';
  else if (signals.some(s => s.signal === 'tax_delinquent')) leadType = 'tax_delinquent';
  else if (signals.some(s => s.signal === 'absentee_owner')) leadType = 'absentee';
  else if (signals.some(s => s.signal === 'price_anomaly')) leadType = 'undervalued';

  return { parcel_id: property.parcel_id, score, signals, leadType };
}

// Generate AI summary for a lead
async function generateSummary(property, signals) {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-...') {
    return buildFallbackSummary(property, signals);
  }

  const signalLabels = signals.map(s => SIGNALS[s.signal]?.label || s.signal).join(', ');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'You are a real estate lead analyst. Write a 1-2 sentence summary of why this property is a potential deal. Be specific and actionable. No hype.',
      }, {
        role: 'user',
        content: `Property: ${property.property_address || 'Unknown address'}, ${property.property_city || ''} FL ${property.property_zip || ''}
Owner: ${property.owner_name || 'Unknown'} (${property.owner_city || ''}, ${property.owner_state || 'FL'})
Type: ${property.property_type || 'Unknown'} | ${property.bedrooms || '?'}BR/${property.bathrooms || '?'}BA | ${property.sqft || '?'} sqft
Assessed: $${(property.assessed_value || 0).toLocaleString()} | Last Sale: $${(property.last_sale_price || 0).toLocaleString()} on ${property.last_sale_date || 'unknown date'}
Homestead: ${property.homestead ? 'Yes' : 'No'}
Signals: ${signalLabels}`,
      }],
      max_tokens: 150,
      temperature: 0.3,
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('OpenAI summary error:', err.message);
    return buildFallbackSummary(property, signals);
  }
}

function buildFallbackSummary(property, signals) {
  const parts = [];
  const addr = property.property_address || 'Property';

  if (signals.some(s => s.signal === 'near_foreclosure')) {
    parts.push(`${addr} is headed to foreclosure auction`);
  }
  if (signals.some(s => s.signal === 'tax_delinquent')) {
    parts.push(`tax delinquent${property.tax_delinquent_years > 1 ? ` for ${property.tax_delinquent_years} years` : ''}`);
  }
  if (signals.some(s => s.signal === 'absentee_owner')) {
    parts.push(`absentee owner in ${property.owner_state}`);
  }
  if (signals.some(s => s.signal === 'price_anomaly')) {
    parts.push(`last sold well below assessed value`);
  }

  return parts.join('; ') + '. Likely motivated seller.';
}

// Score all properties and store leads
async function runScoringEngine(minScore = 30) {
  console.log('Running scoring engine...');

  const { rows: properties } = await db.query(
    'SELECT * FROM properties WHERE updated_at > NOW() - INTERVAL \'7 days\' OR first_seen_at > NOW() - INTERVAL \'7 days\''
  );
  console.log(`Scoring ${properties.length} recently updated properties`);

  let scored = 0;
  let leadsCreated = 0;

  for (const property of properties) {
    const result = await scoreProperty(property);

    if (result.score >= minScore) {
      const summary = await generateSummary(property, result.signals);

      await db.query(`
        INSERT INTO leads (parcel_id, score, signals, ai_summary, lead_type, scored_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT DO NOTHING
      `, [
        result.parcel_id,
        result.score,
        JSON.stringify(result.signals),
        summary,
        result.leadType,
      ]);

      leadsCreated++;
    }
    scored++;

    // Rate limit OpenAI calls
    if (scored % 50 === 0) {
      console.log(`  Scored ${scored}/${properties.length}...`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`Scoring complete: ${scored} scored, ${leadsCreated} leads created (min score: ${minScore})`);
  return { scored, leadsCreated };
}

if (require.main === module) {
  const minScore = parseInt(process.argv[2] || '30', 10);
  runScoringEngine(minScore)
    .then(result => {
      console.log('Scoring complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Scoring failed:', err);
      process.exit(1);
    });
}

module.exports = { runScoringEngine, scoreProperty, generateSummary, SIGNALS };
