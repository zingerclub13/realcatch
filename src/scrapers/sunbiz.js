const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db/pool');

const SUNBIZ_SEARCH = 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchByName';
const SUNBIZ_DETAIL = 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchByDetail';

// Real estate related keywords for filtering LLC filings
const RE_KEYWORDS = [
  'realty', 'property', 'properties', 'invest', 'investment', 'investments',
  'real estate', 'holdings', 'capital', 'development', 'developer',
  'construction', 'building', 'renovation', 'rehab', 'flip', 'flipping',
  'land', 'homes', 'housing', 'rental', 'rentals', 'landlord',
  'mortgage', 'title', 'closing', 'wholesale',
];

function isRERelated(entityName) {
  const lower = entityName.toLowerCase();
  return RE_KEYWORDS.some(kw => lower.includes(kw));
}

// Search for recent LLC filings in Volusia County area
async function searchRecentFilings(days = 7) {
  const results = [];

  try {
    // Search by recent filing date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const res = await axios.get(SUNBIZ_SEARCH, {
      params: {
        searchNameOrder: '',
        searchTerm: '',
        listPage: 1,
        listPageSize: 50,
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'RealCatch/1.0 (Public Data Research)',
        'Accept': 'text/html',
      },
    });

    const $ = cheerio.load(res.data);

    // Parse search results table
    $('table.search-results tr').each((i, row) => {
      if (i === 0) return; // skip header
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const entityName = $(cells[0]).text().trim();
      const docNumber = $(cells[1]).text().trim();
      const status = $(cells[2]).text().trim();
      const filingDate = $(cells[3]).text().trim();

      if (docNumber) {
        results.push({
          document_number: docNumber,
          entity_name: entityName,
          status,
          filing_date: filingDate || null,
          category: isRERelated(entityName) ? 'real_estate' : 'general',
        });
      }
    });
  } catch (err) {
    console.error('Sunbiz search error:', err.message);
  }

  return results;
}

// Get detailed info for a specific entity
async function getEntityDetail(documentNumber) {
  try {
    const res = await axios.get(`${SUNBIZ_DETAIL}/${documentNumber}`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'RealCatch/1.0 (Public Data Research)',
        'Accept': 'text/html',
      },
    });

    const $ = cheerio.load(res.data);
    const detail = {};

    // Parse detail page for principal/registered agent info
    $('div.detailSection').each((i, section) => {
      const label = $(section).find('span.sectionLabel').text().trim().toLowerCase();
      const value = $(section).find('span.sectionValue').text().trim();

      if (label.includes('principal')) detail.principal_name = value;
      if (label.includes('address')) {
        if (!detail.principal_address) {
          detail.principal_address = value;
        }
      }
      if (label.includes('registered agent')) detail.registered_agent = value;
    });

    return detail;
  } catch (err) {
    console.error(`Sunbiz detail ${documentNumber} error:`, err.message);
    return {};
  }
}

// Store filings in database
async function storeFilings(filings) {
  let inserted = 0;

  for (const filing of filings) {
    try {
      await db.query(`
        INSERT INTO llc_filings (
          document_number, entity_name, filing_date, status,
          principal_name, principal_address, principal_city,
          principal_state, principal_zip, registered_agent,
          category, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (document_number) DO NOTHING
      `, [
        filing.document_number, filing.entity_name,
        filing.filing_date, filing.status,
        filing.principal_name || null, filing.principal_address || null,
        filing.principal_city || null, filing.principal_state || null,
        filing.principal_zip || null, filing.registered_agent || null,
        filing.category, JSON.stringify(filing),
      ]);
      inserted++;
    } catch (err) {
      // Skip duplicates silently
      if (!err.message.includes('duplicate')) {
        console.error('Store filing error:', err.message);
      }
    }
  }

  return inserted;
}

// Main run
async function runSunbizScrape(days = 7) {
  console.log(`Searching Sunbiz for filings in last ${days} days...`);
  const filings = await searchRecentFilings(days);
  console.log(`Found ${filings.length} filings`);

  const reFilings = filings.filter(f => f.category === 'real_estate');
  console.log(`${reFilings.length} are real estate related`);

  // Get details for RE-related filings
  for (const filing of reFilings) {
    const detail = await getEntityDetail(filing.document_number);
    Object.assign(filing, detail);
    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  const inserted = await storeFilings(filings);
  console.log(`Stored ${inserted} new filings`);

  return { total: filings.length, reRelated: reFilings.length, inserted };
}

if (require.main === module) {
  const days = parseInt(process.argv[2] || '7', 10);
  runSunbizScrape(days)
    .then(result => {
      console.log('Sunbiz scrape complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Sunbiz scrape failed:', err);
      process.exit(1);
    });
}

module.exports = { runSunbizScrape, searchRecentFilings, isRERelated };
