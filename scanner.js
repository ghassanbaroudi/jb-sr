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
  const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
  const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('Adzuna credentials missing. Add them to GitHub Secrets.');
    return [];
  }

  // Use Adzuna's UK search endpoint. 
  // 'what' searches keywords, 'where' sets location, 'full_time' ensures it's not a short internship.
  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1`;

  try {
    const res = await axios.get(url, {
      params: {
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        what: 'graduate OR analyst OR finance OR banking',
        where: 'London',
        results_per_page: 50,
      }
    });

    const jobs = res.data.results || [];
    
    jobs.forEach(job => {
      const title = job.title || '';
      const description = job.description || '';
      const company = job.company?.display_name || 'Unknown Company';
      const jobUrl = job.redirect_url;
      
      // We still run your strict negative filters to exclude STEM/Quant/No-Visa roles
      if (title && jobUrl && matchesCriteria(title, description)) {
        const id = job.id.toString(); 
        discoveredJobs.push({ id, title, company, location: 'London, UK', url: jobUrl });
      }
    });
  } catch (err) {
    console.error('Error fetching from Adzuna API:', err.response?.data || err.message);
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
