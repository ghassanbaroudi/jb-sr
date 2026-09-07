import fs from 'fs';
import path from 'path';
import axios from 'axios';

const SEEN_JOBS_FILE = path.resolve('seen_jobs.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

// Open-source LLM evaluator (Llama-3.3-70B via Groq)
async function evaluateJobWithLLM(title, description, company) {
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY missing. Skipping AI evaluation.');
    return { matches: false };
  }

  const systemPrompt = `
You are an expert career screener. Evaluate if a job posting matches the candidate's exact profile.

CANDIDATE PROFILE:
- Education: Business, management, or finance background, graduating in 2027.
- Target Roles: Asset management, wealth management, corporate banking, investment research, capital markets (non-quant), corporate finance, strategy, or management consulting.
- Target Level: Full-time graduate programmes or entry-level analyst roles starting in 2027.
- Location Focus: London/UK.
- Visa Requirement: Requires UK Skilled Worker visa sponsorship.

STRICT DEALBREAKERS (Reject if ANY are true):
- It is a Software Engineering, Data Science, IT, or technical builder role.
- It requires STEM, advanced math, PhD, or is highly quantitative (quant trading/research).
- It is Audit, pure Tax, Compliance, HR, or back-office operations.
- It explicitly states NO visa sponsorship or requires unrestricted right to work.
- It is a summer internship exclusively for 2028 graduates.

Respond ONLY with a valid JSON object matching this schema:
{
  "matches": boolean,
  "fit": "Strong Fit" | "Possible" | "Poor Fit",
  "reason": "1 short sentence explaining why."
}
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Company: ${company}\nTitle: ${title}\nDescription: ${description}` }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return JSON.parse(response.data.choices[0].message.content);
  } catch (error) {
    console.error(`LLM evaluation failed for ${title}:`, error.response?.data?.error?.message || error.message);
    return { matches: false };
  }
}

async function sendTelegramAlert(job, fit, reason) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const message = [
    `🎯 *New 2027 Graduate Opportunity*`,
    ``,
    `*Role:* ${job.title}`,
    `*Company:* ${job.company}`,
    `*Fit:* ${fit}`,
    `*AI Verdict:* ${reason}`,
    ``,
    `🔗 [Application Link](${job.url})`
  ].join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    console.log(`Alert sent: ${job.title} (${fit})`);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.response?.data || err.message);
  }
}

async function fetchJobs() {
  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1`;
  const searchTerms = ['graduate', 'analyst']; // Two simple, broad searches
  let allJobs = [];

  try {
    for (const term of searchTerms) {
      const res = await axios.get(url, {
        params: {
          app_id: ADZUNA_APP_ID,
          app_key: ADZUNA_APP_KEY,
          what: term,
          where: 'London',
          results_per_page: 30 // Pulls 30 of each, 60 total
        }
      });

      const jobs = (res.data.results || []).map(job => ({
        id: job.id.toString(),
        title: job.title || '',
        company: job.company?.display_name || 'Unknown Employer',
        description: job.description || '',
        url: job.redirect_url
      }));

      allJobs = allJobs.concat(jobs);
    }

    // Deduplicate in case a job appeared in both the 'graduate' and 'analyst' searches
    const uniqueJobs = Array.from(new Map(allJobs.map(job => [job.id, job])).values());
    return uniqueJobs;

  } catch (err) {
    console.error('Adzuna fetch error:', err.response?.data || err.message);
    return [];
  }
}
async function run() {
  const seenJobs = loadSeenJobs();
  const seenIds = new Set(seenJobs.map(j => (typeof j === 'string' ? j : j.id)));

  console.log(`Starting scan... ${seenIds.size} previously seen jobs in history.`);
  const jobs = await fetchJobs();
  console.log(`Fetched ${jobs.length} candidates from Adzuna.`);

  let newMatches = 0;

  for (const job of jobs) {
    if (seenIds.has(job.id)) continue;

    console.log(`Evaluating with AI: "${job.title}" at ${job.company}...`);
    const evaluation = await evaluateJobWithLLM(job.title, job.description, job.company);

    if (evaluation.matches) {
      await sendTelegramAlert(job, evaluation.fit, evaluation.reason);
      newMatches++;
      // Polite delay to prevent Telegram rate limits
      await new Promise(r => setTimeout(r, 1500)); 
    }

    seenIds.add(job.id);
    seenJobs.push({
      id: job.id,
      title: job.title,
      company: job.company,
      matched: evaluation.matches,
      date: new Date().toISOString()
    });

    // Small delay between AI requests to respect Groq rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  saveSeenJobs(seenJobs);
  console.log(`Scan finished. Dispatched ${newMatches} qualifying roles.`);
}

run();
