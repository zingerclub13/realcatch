const cron = require('node-cron');
const { runFullScrape: scrapeVcpa } = require('../scrapers/vcpa');
const { runSunbizScrape } = require('../scrapers/sunbiz');
const { runForeclosureScrape } = require('../scrapers/foreclosure');
const { runScoringEngine } = require('../scoring/engine');
const { findProspects, sendOutreach } = require('../prospector/finder');
const { sendDigests } = require('../prospector/emailer');

function startScheduler() {
  console.log('Starting cron scheduler...');

  // Daily at 2 AM: scrape foreclosures
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Starting foreclosure scrape...');
    try {
      await runForeclosureScrape('volusia');
      console.log('[CRON] Foreclosure scrape complete');
    } catch (err) {
      console.error('[CRON] Foreclosure scrape failed:', err.message);
    }
  });

  // Daily at 3 AM: scrape Sunbiz new filings
  cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Starting Sunbiz scrape...');
    try {
      await runSunbizScrape(1);
      console.log('[CRON] Sunbiz scrape complete');
    } catch (err) {
      console.error('[CRON] Sunbiz scrape failed:', err.message);
    }
  });

  // Daily at 4 AM: run scoring engine
  cron.schedule('0 4 * * *', async () => {
    console.log('[CRON] Starting scoring engine...');
    try {
      await runScoringEngine(30);
      console.log('[CRON] Scoring engine complete');
    } catch (err) {
      console.error('[CRON] Scoring engine failed:', err.message);
    }
  });

  // Daily at 7 AM: send daily digests
  cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] Sending daily digests...');
    try {
      await sendDigests('daily');
      console.log('[CRON] Daily digests sent');
    } catch (err) {
      console.error('[CRON] Daily digest failed:', err.message);
    }
  });

  // Weekly Monday 7 AM: send weekly digests
  cron.schedule('0 7 * * 1', async () => {
    console.log('[CRON] Sending weekly digests...');
    try {
      await sendDigests('weekly');
      console.log('[CRON] Weekly digests sent');
    } catch (err) {
      console.error('[CRON] Weekly digest failed:', err.message);
    }
  });

  // Weekly Wednesday 10 AM: find and email new prospects
  cron.schedule('0 10 * * 3', async () => {
    console.log('[CRON] Running prospector...');
    try {
      const prospects = await findProspects();
      if (prospects.length > 0) {
        await sendOutreach(prospects);
      }
      console.log(`[CRON] Prospector complete: ${prospects.length} new prospects`);
    } catch (err) {
      console.error('[CRON] Prospector failed:', err.message);
    }
  });

  console.log('Cron scheduler started with 6 scheduled jobs');
}

module.exports = { startScheduler };
