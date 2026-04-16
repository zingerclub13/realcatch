const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('csv-parse/sync');
const db = require('../db/pool');

const VCPA_BASE = 'https://vcpa.vcgov.org';

// Volusia County Property Appraiser scraper
// Downloads tax roll data and parses property records

async function scrapePropertySearch(address) {
  try {
    const res = await axios.get(`${VCPA_BASE}/api/property/search`, {
      params: { query: address },
      timeout: 15000,
      headers: { 'User-Agent': 'RealCatch/1.0 (Public Data Research)' },
    });
    return res.data;
  } catch (err) {
    console.error('VCPA search error:', err.message);
    return null;
  }
}

async function scrapeParcelDetail(parcelId) {
  try {
    const res = await axios.get(`${VCPA_BASE}/api/property/${parcelId}`, {
      timeout: 15000,
      headers: { 'User-Agent': 'RealCatch/1.0 (Public Data Research)' },
    });
    return res.data;
  } catch (err) {
    console.error(`VCPA parcel ${parcelId} error:`, err.message);
    return null;
  }
}

// Parse CSV tax roll data (downloaded manually or via scheduled job)
function parseTaxRollCSV(csvContent) {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  return records.map(row => ({
    parcel_id: row['PARCEL_ID'] || row['Parcel ID'] || row['parcel_id'],
    owner_name: row['OWNER_NAME'] || row['Owner Name'] || row['owner_name'],
    owner_address: row['OWNER_ADDR'] || row['Owner Address'] || row['owner_address'],
    owner_city: row['OWNER_CITY'] || row['Owner City'] || row['owner_city'],
    owner_state: row['OWNER_STATE'] || row['Owner State'] || row['owner_state'],
    owner_zip: row['OWNER_ZIP'] || row['Owner Zip'] || row['owner_zip'],
    property_address: row['PROP_ADDR'] || row['Property Address'] || row['property_address'],
    property_city: row['PROP_CITY'] || row['Property City'] || row['property_city'],
    property_zip: row['PROP_ZIP'] || row['Property Zip'] || row['property_zip'],
    property_type: row['PROP_TYPE'] || row['Property Type'] || row['property_type'],
    assessed_value: parseInt(row['ASSESSED_VALUE'] || row['Assessed Value'] || '0', 10) || null,
    market_value: parseInt(row['MARKET_VALUE'] || row['Market Value'] || '0', 10) || null,
    taxable_value: parseInt(row['TAXABLE_VALUE'] || row['Taxable Value'] || '0', 10) || null,
    last_sale_date: row['SALE_DATE'] || row['Last Sale Date'] || null,
    last_sale_price: parseInt(row['SALE_PRICE'] || row['Last Sale Price'] || '0', 10) || null,
    homestead: (row['HOMESTEAD'] || row['Homestead'] || '').toUpperCase() === 'Y',
    year_built: parseInt(row['YEAR_BUILT'] || row['Year Built'] || '0', 10) || null,
    bedrooms: parseInt(row['BEDROOMS'] || row['Bedrooms'] || '0', 10) || null,
    bathrooms: parseFloat(row['BATHROOMS'] || row['Bathrooms'] || '0') || null,
    sqft: parseInt(row['SQFT'] || row['Living Area'] || '0', 10) || null,
    acreage: parseFloat(row['ACREAGE'] || row['Acres'] || '0') || null,
    legal_description: row['LEGAL_DESC'] || row['Legal Description'] || null,
    raw_data: row,
  }));
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

// Main scrape job: download tax roll, detect changes, upsert
async function runFullScrape(csvFilePath) {
  const fs = require('fs');

  if (!csvFilePath) {
    console.log('No CSV file provided. Provide path to tax roll CSV as argument.');
    console.log('Usage: node src/scrapers/vcpa.js /path/to/taxroll.csv');
    return;
  }

  console.log(`Loading tax roll from: ${csvFilePath}`);
  const csvContent = fs.readFileSync(csvFilePath, 'utf8');
  const properties = parseTaxRollCSV(csvContent);
  console.log(`Parsed ${properties.length} properties`);

  if (properties.length === 0) {
    console.log('No properties parsed. Check CSV format.');
    return;
  }

  console.log('Detecting ownership changes...');
  const changes = await detectOwnershipChanges(properties);
  console.log(`Found ${changes.length} ownership changes`);

  console.log('Upserting properties...');
  const result = await upsertProperties(properties);
  console.log(`Done: ${result.inserted} inserted, ${result.updated} updated`);

  return { properties: properties.length, changes: changes.length, ...result };
}

// Run from CLI
if (require.main === module) {
  const csvPath = process.argv[2];
  runFullScrape(csvPath)
    .then(result => {
      console.log('Scrape complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Scrape failed:', err);
      process.exit(1);
    });
}

module.exports = { runFullScrape, parseTaxRollCSV, upsertProperties, detectOwnershipChanges, scrapePropertySearch };
