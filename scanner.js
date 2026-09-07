import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';

const SEEN_JOBS_FILE = path.resolve('seen_jobs.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Keywords that indicate a relevant role
const POSITIVE_KEYWORDS = [
  'graduate', 'analyst', 'asset management', 'wealth management',
  'private banking', 'corporate banking', 'equity research',
  'investment research', 'capital markets', 'global markets',
  'sales and trading', 'corporate finance', 'strategy',
  'management consulting', 'client solutions', 'rotational', '2027'
];

// Strict exclusions based on your profile and dealbreakers
const NEGATIVE_KEYWORDS = [
  'software', 'developer', 'data scientist', 'machine learning', 'artificial intelligence',
  'quant', 'quantitative', 'phd', 'stem', 'actuarial', 'actuary', 'engineering',
  'audit', 'tax', 'compliance', 'internal audit', 'accounting scheme',
  '2028', 'summer intern 2028',
  'no visa', 'cannot sponsor', 'no sponsorship', 'unrestricted right to work required'
];

function loadSeenJobs() {
  if (fs.existsSync(SEEN_JOBS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SEEN_JOBS_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveSeenJobs(jobs) {
  fs.writeFileSync(SEEN_JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

function matchesCriteria(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();

  // Exclude unwanted disciplines or negative sponsorship flags
  const hasNegative = NEGATIVE_KEYWORDS.some(kw => text.includes(kw));
  if (hasNegative) return false;

  // Must contain at least one target discipline/keyword
  const hasPositive = POSITIVE_KEYWORDS.some(kw => text.includes(kw));
  return hasPositive;
}

async function sendTelegramAlert(job) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials missing.');
    return;
  }

  const message = [
    `🎯 *New 2027 Graduate Opportunity Found*`,
    ``,
    `*Role:* ${job.title}`,
    `*Company:* ${job.company}`,
    `*Location:* ${job.location}`,
    `*Sponsorship:* Check posting (Excluded known non-sponsors)`,
    ``,
    `🔗 [Direct Application Link](${job.url})`
  ].join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    console.log(`Alert sent for: ${job.title} at ${job.company}`);
  } catch (error) {
    console.error(`Failed to send Telegram alert:`, error.response?.data || error.message);
  }
}

// Scrape targeted public feeds and job aggregators
// Scrape targeted public feeds and job aggregators
async function fetchJobs() {
  const discoveredJobs = [];
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

  if (!SCRAPER_API_KEY) {
    console.error('SCRAPER_API_KEY is missing. Add it to GitHub Secrets.');
    return [];
  }

  // Source 1: Targeted London Graduate Search Feed
  try {
    const searchUrl = 'https://www.gradcracker.com/search/all-disciplines/business-degree-jobs-in-london';
    const res = await axios.get('https://api.scraperapi.com', {
      params: { api_key: SCRAPER_API_KEY, url: searchUrl }
    });

    const $ = cheerio.load(res.data);
    $('.job-card, .tw-mb-4').each((_, el) => {
      const title = $(el).find('h2, .tw-font-bold').text().trim();
      const company = $(el).find('.employer-name, .tw-text-gray-600').first().text().trim();
      const relativeUrl = $(el).find('a').attr('href');
      const url = relativeUrl?.startsWith('http') ? relativeUrl : `https://www.gradcracker.com${relativeUrl}`;

      if (title && url && matchesCriteria(title)) {
        const id = `gc_${title.replace(/\s+/g, '_')}_${company.replace(/\s+/g, '_')}`.toLowerCase();
        discoveredJobs.push({ id, title, company, location: 'London, UK', url });
      }
    });
  } catch (err) {
    console.warn('Notice: Primary aggregator fetch skipped:', err.message);
  }

  // Source 2: Direct Careers Feed
  try {
    const bnUrl = 'https://www.brightnetwork.co.uk/graduate-jobs/?location=London&sector=Banking%2C+Private+Equity+%26+Asset+Management&sector=Consulting';
    const res = await axios.get('https://api.scraperapi.com', {
      params: { api_key: SCRAPER_API_KEY, url: bnUrl }
    });

    const $ = cheerio.load(res.data);
    $('a[href*="/graduate-jobs/"]').each((_, el) => {
      const title = $(el).find('h3, h4').text().trim();
      const company = $(el).find('.company-name, span').first().text().trim() || 'London Financial Institution';
      const url = $(el).attr('href')?.startsWith('http') ? $(el).attr('href') : `https://www.brightnetwork.co.uk${$(el).attr('href')}`;

      if (title && url && matchesCriteria(title)) {
        const id = `bn_${title.replace(/\s+/g, '_')}_${company.replace(/\s+/g, '_')}`.toLowerCase();
        discoveredJobs.push({ id, title, company, location: 'London, UK', url });
      }
    });
  } catch (err) {
    console.warn('Notice: Secondary early-careers source skipped:', err.message);
  }

  return discoveredJobs;
}

async function run() {
  const seenJobs = loadSeenJobs();
  const seenIds = new Set(seenJobs.map(j => (typeof j === 'string' ? j : j.id)));

  console.log(`Starting scan... Loaded ${seenIds.size} previously seen jobs.`);
  const currentJobs = await fetchJobs();

  let newCount = 0;
  for (const job of currentJobs) {
    if (!seenIds.has(job.id)) {
      await sendTelegramAlert(job);
      seenIds.add(job.id);
      seenJobs.push({ id: job.id, title: job.title, company: job.company, date: new Date().toISOString() });
      newCount++;
      // Polite 1-second pause to prevent Telegram rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  saveSeenJobs(seenJobs);
  console.log(`Scan completed. Dispatched ${newCount} new opportunities.`);
}

run();
