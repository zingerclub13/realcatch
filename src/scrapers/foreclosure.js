const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db/pool');

const REALFORECLOSE_URL = 'https://www.realforeclose.com/index.cfm';

// Scrape Volusia County foreclosure auctions
async function scrapeForeclosures(county = 'volusia') {
  const results = [];

  try {
    const res = await axios.get(REALFORECLOSE_URL, {
      params: {
        zession: 'foreclosure',
        county: county,
        searchType: 'date',
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'RealCatch/1.0 (Public Data Research)',
        'Accept': 'text/html',
      },
    });

    const $ = cheerio.load(res.data);

    // Parse auction listings
    $('table.AUCTION_DETAILS tr, div.auction-item').each((i, el) => {
      const cells = $(el).find('td');
      if (cells.length < 5) return;

      const caseNumber = $(cells[0]).text().trim();
      const address = $(cells[1]).text().trim();
      const defendant = $(cells[2]).text().trim();
      const auctionDate = $(cells[3]).text().trim();
      const openingBid = $(cells[4]).text().trim().replace(/[$,]/g, '');

      if (caseNumber && caseNumber.length > 3) {
        results.push({
          case_number: caseNumber,
          property_address: address,
          defendant_name: defendant,
          auction_date: auctionDate || null,
          opening_bid: parseFloat(openingBid) || null,
          status: 'scheduled',
        });
      }
    });

    // Also try JSON API endpoint if available
    if (results.length === 0) {
      try {
        const apiRes = await axios.get(`https://www.realforeclose.com/api/auctions`, {
          params: { county },
          timeout: 15000,
          headers: { 'User-Agent': 'RealCatch/1.0 (Public Data Research)' },
        });

        if (Array.isArray(apiRes.data)) {
          for (const item of apiRes.data) {
            results.push({
              case_number: item.caseNumber || item.case_number,
              property_address: item.address || item.property_address,
              defendant_name: item.defendant || item.defendant_name,
              plaintiff_name: item.plaintiff || item.plaintiff_name,
              auction_date: item.auctionDate || item.auction_date,
              opening_bid: parseFloat(String(item.openingBid || item.opening_bid || '0').replace(/[$,]/g, '')) || null,
              assessed_value: parseInt(item.assessedValue || item.assessed_value || '0', 10) || null,
              parcel_id: item.parcelId || item.parcel_id || null,
              status: 'scheduled',
            });
          }
        }
      } catch {
        // API not available, use HTML results
      }
    }
  } catch (err) {
    console.error('Foreclosure scrape error:', err.message);
  }

  return results;
}

// Parse city/zip from address
function parseAddress(address) {
  if (!address) return { city: null, zip: null };

  const zipMatch = address.match(/\b(\d{5})\b/);
  const zip = zipMatch ? zipMatch[1] : null;

  // Try to extract city (before state abbreviation or zip)
  const cityMatch = address.match(/,\s*([A-Za-z\s]+),?\s*FL/i);
  const city = cityMatch ? cityMatch[1].trim() : null;

  return { city, zip };
}

// Store foreclosures in database
async function storeForeclosures(foreclosures) {
  let inserted = 0;

  for (const fc of foreclosures) {
    if (!fc.case_number) continue;

    const { city, zip } = parseAddress(fc.property_address);

    try {
      await db.query(`
        INSERT INTO foreclosures (
          case_number, property_address, city, zip,
          defendant_name, plaintiff_name, auction_date,
          opening_bid, assessed_value, parcel_id, status, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (case_number) DO UPDATE SET
          auction_date = EXCLUDED.auction_date,
          opening_bid = EXCLUDED.opening_bid,
          status = EXCLUDED.status,
          raw_data = EXCLUDED.raw_data
      `, [
        fc.case_number, fc.property_address, city, zip,
        fc.defendant_name, fc.plaintiff_name || null,
        fc.auction_date, fc.opening_bid, fc.assessed_value || null,
        fc.parcel_id || null, fc.status, JSON.stringify(fc),
      ]);
      inserted++;
    } catch (err) {
      console.error('Store foreclosure error:', err.message);
    }
  }

  return inserted;
}

async function runForeclosureScrape(county = 'volusia') {
  console.log(`Scraping foreclosures for ${county} county...`);
  const foreclosures = await scrapeForeclosures(county);
  console.log(`Found ${foreclosures.length} auction listings`);

  const inserted = await storeForeclosures(foreclosures);
  console.log(`Stored/updated ${inserted} foreclosures`);

  return { total: foreclosures.length, stored: inserted };
}

if (require.main === module) {
  const county = process.argv[2] || 'volusia';
  runForeclosureScrape(county)
    .then(result => {
      console.log('Foreclosure scrape complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Foreclosure scrape failed:', err);
      process.exit(1);
    });
}

module.exports = { runForeclosureScrape, scrapeForeclosures };
