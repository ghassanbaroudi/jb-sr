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
    console.error('GROQ_API_KEY missing.');
    return { matches: false };
  }

  const systemPrompt = `
You are an expert career screener. Evaluate if a job posting matches the candidate's profile.

CANDIDATE CRITERIA:
- Education/Background: Business, management, or finance degree graduating in 2027.
- Target Roles: Asset management, wealth management, corporate banking, investment research, capital markets, sales & trading (non-quant), corporate finance, strategy, management consulting, or client solutions.
- Target Level: 2027 Graduate programmes, full-time analyst schemes, or off-cycles leading to 2027 full-time.

HARD DEALBREAKERS (Reject if true):
- Requires STEM, computer science, software development, data science, machine learning, quant/quantitative finance, actuarial, or engineering degrees.
- Accounting-only, audit, compliance, HR, or pure tax schemes.
- Summer internships exclusively for 2028 graduates.
- Explicitly states no visa sponsorship or requires existing unrestricted UK right to work (candidate needs Skilled Worker sponsorship).

Respond ONLY with a valid JSON object matching this schema:
{
  "matches": boolean,
  "fit": "Strong Fit" | "Possible" | "Poor Fit",
  "reason": "1-2 concise sentences explaining the fit or rejection"
}
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
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
        timeout: 10000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    return result;
  } catch (error) {
    console.error(`LLM evaluation failed for ${title}:`, error.response?.data?.error?.message || error.message);
    return { matches: false };
  }
}

async function sendTelegramAlert(job, fit, reason) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const message = [
    `🎯 *New Graduate Opportunity Match*`,
    ``,
    `*Role:* ${job.title}`,
    `*Company:* ${job.company}`,
    `*Fit:* ${fit}`,
    `*AI Verdict:* ${reason}`,
    ``,
    `🔗 [Application / Details Link](${job.url})`
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
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('Adzuna credentials missing.');
    return [];
  }

  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1`;
  try {
    const res = await axios.get(url, {
      params: {
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        what: 'graduate OR analyst OR "asset management" OR banking OR consulting',
        where: 'London',
        results_per_page: 25,
        max_days_old: 2
      }
    });

    return (res.data.results || []).map(job => ({
      id: job.id.toString(),
      title: job.title || '',
      company: job.company?.display_name || 'Unknown Employer',
      description: job.description || '',
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

  console.log(`Starting scan... ${seenIds.size} previously seen jobs in history.`);
  const jobs = await fetchJobs();
  console.log(`Fetched ${jobs.length} candidates from search endpoint.`);

  let newMatches = 0;

  for (const job of jobs) {
    if (seenIds.has(job.id)) continue;

    console.log(`Evaluating: "${job.title}" at ${job.company}...`);
    const evaluation = await evaluateJobWithLLM(job.title, job.description, job.company);

    if (evaluation.matches) {
      await sendTelegramAlert(job, evaluation.fit, evaluation.reason);
      newMatches++;
      await new Promise(r => setTimeout(r, 1000));
    }

    seenIds.add(job.id);
    seenJobs.push({
      id: job.id,
      title: job.title,
      company: job.company,
      matched: evaluation.matches,
      date: new Date().toISOString()
    });
  }

  saveSeenJobs(seenJobs);
  console.log(`Scan finished. Dispatched ${newMatches} qualifying roles.`);
}

run();
