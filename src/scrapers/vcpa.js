const axios = require('axios');
const { parse } = require('csv-parse/sync');
const db = require('../db/pool');

const VCPA_BASE = 'https://vcpa.vcgov.org';

// All Volusia County Non-Homestead extract files (updated weekly by VCPA)
const NONHX_CITIES = [
  'DAYTONA_BEACH', 'DBS', 'DEBARY', 'DELAND', 'DELTONA',
  'EDGEWATER', 'FLAGLER_BEACH', 'HOLLY_HILL', 'LAKE_HELEN',
  'NSB', 'OAK_HILL', 'ORANGE_CITY', 'ORMOND', 'PIERSON',
  'PONCE_INLET', 'PORT_ORANGE', 'SOUTH_DAYTONA',
  'UNINCORPORATED_NE', 'UNINCORPORATED_SILVER_SANDS',
  'UNINCORPORATED_SE', 'UNINCORPORATED_WEST',
];

// Download a single city's Non-HX extract CSV
async function downloadCityCSV(cityKey) {
  const url = `${VCPA_BASE}/files/extracts/nonhx/${cityKey}_NONHX_EXTRACT.csv`;
  try {
    const res = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'RealCatch/1.0 (Public Data Research)' },
      responseType: 'text',
    });
    return res.data;
  } catch (err) {
    console.error(`Failed to download ${cityKey}: ${err.message}`);
    return null;
  }
}

// Parse VCPA Non-HX extract CSV (actual column names from vcpa.vcgov.org)
function parseNonHxCSV(csvContent) {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  return records.map(row => {
    // Parse mailing address for owner city/state/zip
    const mailingParts = parseMailingAddress(
      row['mailing_address1'], row['mailing_address2'], row['mailing_address3']
    );

    return {
      parcel_id: row['parcelid'],
      owner_name: row['owner'],
      owner_address: [row['mailing_address1'], row['mailing_address2']].filter(Boolean).join(', '),
      owner_city: mailingParts.city,
      owner_state: mailingParts.state,
      owner_zip: mailingParts.zip,
      property_address: row['situs'],
      property_city: row['situs_city'],
      property_zip: row['situs_zipcode'],
      property_type: row['pc_desc'] || null,
      assessed_value: parseInt(row['just_value'] || '0', 10) || null,
      market_value: parseInt(row['just_value'] || '0', 10) || null,
      taxable_value: null,
      last_sale_date: row['last_saledt'] || null,
      last_sale_price: parseInt(row['last_saleprice'] || '0', 10) || null,
      homestead: (row['has_hx'] || '').toUpperCase() === 'Y',
      year_built: null,
      bedrooms: parseInt(row['# of bedrooms'] || '0', 10) || null,
      bathrooms: parseFloat(row['# of bathrooms'] || '0') || null,
      sqft: parseInt(row['res sfla'] || '0', 10) || null,
      acreage: parseFloat(row['land acres'] || '0') || null,
      legal_description: [row['legal1'], row['legal2'], row['legal3']].filter(Boolean).join(' '),
      raw_data: row,
    };
  });
}

// Extract city, state, zip from VCPA mailing address line 3 (typically "CITY ST ZIP")
function parseMailingAddress(addr1, addr2, addr3) {
  const result = { city: null, state: null, zip: null };
  const line = addr3 || addr2 || '';
  if (!line) return result;

  // Match patterns like "DAYTONA BEACH FL 32114" or "NEW YORK NY 10001-2345"
  const match = line.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (match) {
    result.city = match[1].trim();
    result.state = match[2];
    result.zip = match[3];
  }
  return result;
}

// Upsert properties into the database
async function upsertProperties(properties) {
  const client = await db.getClient();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const prop of properties) {
      if (!prop.parcel_id) continue;

      const result = await client.query(`
        INSERT INTO properties (
          parcel_id, owner_name, owner_address, owner_city, owner_state, owner_zip,
          property_address, property_city, property_zip, property_type,
          assessed_value, market_value, taxable_value,
          last_sale_date, last_sale_price, homestead,
          year_built, bedrooms, bathrooms, sqft, acreage,
          legal_description, raw_data, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
        ON CONFLICT (parcel_id) DO UPDATE SET
          owner_name = EXCLUDED.owner_name,
          owner_address = EXCLUDED.owner_address,
          owner_city = EXCLUDED.owner_city,
          owner_state = EXCLUDED.owner_state,
          owner_zip = EXCLUDED.owner_zip,
          assessed_value = EXCLUDED.assessed_value,
          market_value = EXCLUDED.market_value,
          taxable_value = EXCLUDED.taxable_value,
          last_sale_date = EXCLUDED.last_sale_date,
          last_sale_price = EXCLUDED.last_sale_price,
          homestead = EXCLUDED.homestead,
          tax_delinquent = EXCLUDED.tax_delinquent,
          raw_data = EXCLUDED.raw_data,
          updated_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `, [
        prop.parcel_id, prop.owner_name, prop.owner_address,
        prop.owner_city, prop.owner_state, prop.owner_zip,
        prop.property_address, prop.property_city, prop.property_zip,
        prop.property_type, prop.assessed_value, prop.market_value,
        prop.taxable_value, prop.last_sale_date, prop.last_sale_price,
        prop.homestead, prop.year_built, prop.bedrooms, prop.bathrooms,
        prop.sqft, prop.acreage, prop.legal_description,
        JSON.stringify(prop.raw_data),
      ]);

      if (result.rows[0]?.is_insert) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated };
}

// Detect ownership changes by comparing current vs new data
async function detectOwnershipChanges(properties) {
  const changes = [];

  for (const prop of properties) {
    if (!prop.parcel_id) continue;

    const existing = await db.query(
      'SELECT owner_name, last_sale_date, last_sale_price FROM properties WHERE parcel_id = $1',
      [prop.parcel_id]
    );

    if (existing.rows.length && existing.rows[0].owner_name !== prop.owner_name) {
      changes.push({
        parcel_id: prop.parcel_id,
        old_owner: existing.rows[0].owner_name,
        new_owner: prop.owner_name,
        sale_date: prop.last_sale_date,
        sale_price: prop.last_sale_price,
      });
    }
  }

  // Store changes
  for (const change of changes) {
    await db.query(
      `INSERT INTO ownership_changes (parcel_id, old_owner, new_owner, sale_date, sale_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [change.parcel_id, change.old_owner, change.new_owner, change.sale_date, change.sale_price]
    );
  }

  return changes;
}

// Main scrape job: download all Non-HX CSVs, detect changes, upsert
async function runFullScrape() {
  console.log('Starting VCPA Non-HX extract download...');
  let totalProperties = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalChanges = 0;

  for (const city of NONHX_CITIES) {
    console.log(`  Downloading ${city}...`);
    const csv = await downloadCityCSV(city);
    if (!csv) continue;

    const properties = parseNonHxCSV(csv);
    console.log(`  Parsed ${properties.length} properties from ${city}`);
    if (properties.length === 0) continue;

    const changes = await detectOwnershipChanges(properties);
    totalChanges += changes.length;

    const result = await upsertProperties(properties);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalProperties += properties.length;

    // Rate limit between cities
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`VCPA scrape complete: ${totalProperties} properties, ${totalInserted} new, ${totalUpdated} updated, ${totalChanges} ownership changes`);
  return { properties: totalProperties, inserted: totalInserted, updated: totalUpdated, changes: totalChanges };
}

// Run from CLI
if (require.main === module) {
  runFullScrape()
    .then(result => {
      console.log('Scrape complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Scrape failed:', err);
      process.exit(1);
    });
}

module.exports = { runFullScrape, parseNonHxCSV, upsertProperties, detectOwnershipChanges };
