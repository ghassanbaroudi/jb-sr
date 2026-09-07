import fs from 'fs';
import path from 'path';
import axios from 'axios';

const SEEN_JOBS_FILE = path.resolve('seen_jobs.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

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

async function sendTelegramAlert(job) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const message = `🚨 *Test Alert: Pipeline is Working!* 🚨\n\n*Role:* ${job.title}\n*Company:* ${job.company}\n\n🔗 [Link](${job.url})`;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log(`Alert sent: ${job.title}`);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.response?.data || err.message);
  }
}

async function fetchJobs() {
  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1`;
  try {
    const res = await axios.get(url, {
      params: {
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        what: 'analyst', // Extremely broad search
        where: 'London',
        results_per_page: 5 
      }
    });

    return (res.data.results || []).map(job => ({
      id: job.id.toString(),
      title: job.title || '',
      company: job.company?.display_name || 'Unknown Employer',
      url: job.redirect_url
    }));
  } catch (err) {
    console.error('Adzuna fetch error:', err.response?.data || err.message);
    return [];
  }
}

async function run() {
  const seenJobs = loadSeenJobs();
  const seenIds = new Set(seenJobs.map(j => (typeof j === 'string' ? j : j.id)));

  console.log('Fetching raw test jobs from Adzuna...');
  const jobs = await fetchJobs();
  console.log(`Found ${jobs.length} jobs.`);

  let dispatched = 0;
  for (const job of jobs) {
    if (seenIds.has(job.id)) continue;

    console.log(`Sending to Telegram: ${job.title}`);
    await sendTelegramAlert(job);
    dispatched++;

    seenIds.add(job.id);
    seenJobs.push({ id: job.id, title: job.title });

    // Only send the first 2 we find to verify functionality
    if (dispatched >= 2) break; 
  }

  saveSeenJobs(seenJobs);
  console.log(`Test complete. Dispatched ${dispatched} test roles.`);
}

run();
