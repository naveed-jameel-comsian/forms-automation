require('dotenv').config();

function clean(value) {
    return typeof value === 'string' ? value.trim() : value;
}

const config = {
    supabase: {
        url: clean(process.env.SUPABASE_URL || process.env.SUPAURL),
        key: clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY),
    },
    claude: {
        apiKey: clean(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY),
        model: clean(process.env.CLAUDE_MODEL || 'claude-sonnet-4-5'),
    },
    twoCaptchaKey: clean(process.env['2CAPTCHA_API_KEY']),
    imap: {
        host: clean(process.env.IMAP_HOST || 'imap.gmail.com'),
        port: Number(process.env.IMAP_PORT || 993),
        user: clean(process.env.GMAIL_IMAP_USER || process.env.EMAIL),
        pass: (process.env.GMAIL_IMAP_PASS || process.env.PASS || '').replace(/\s+/g, ''),
    },
    tables: {
        forums: clean(process.env.FORUMS_TABLE || 'forums'),
        logs: clean(process.env.LOGS_TABLE || 'agent_seo_logs'),
    },
    dailyLimit: Number(process.env.DAILY_LIMIT || 10),
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 2),
    headless: process.env.HEADLESS !== 'false',
    // Delay window (minutes) between forums in a batch — Step 8.
    batchDelayMinMin: Number(process.env.BATCH_DELAY_MIN || 45),
    batchDelayMaxMin: Number(process.env.BATCH_DELAY_MAX || 90),
    // Cron schedule for the daily batch — Step 8 (default 10:00 every day).
    cronSchedule: clean(process.env.CRON_SCHEDULE || '0 10 * * *'),
    cronTimezone: clean(process.env.CRON_TZ || 'Europe/Paris'),
    // IMAP watch window — Step 6 (2 hours).
    emailTimeoutMs: Number(process.env.EMAIL_TIMEOUT_MS || 2 * 60 * 60 * 1000),
    // Manual admin validation: how long we keep watching for the approval email (7 days).
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 7 * 24 * 60 * 60 * 1000),
    // How often the approval inbox re-check runs (default every 2 hours).
    approvalCron: clean(process.env.APPROVAL_CRON || '0 */2 * * *'),
    approvalBatchLimit: Number(process.env.APPROVAL_BATCH_LIMIT || 100),
};

function validate() {
    const missing = [];
    if (!config.supabase.url) missing.push('SUPABASE_URL (or SUPAURL)');
    if (!config.supabase.key) missing.push('SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY)');
    if (!config.claude.apiKey) missing.push('CLAUDE_API_KEY');
    if (!config.imap.user) missing.push('EMAIL (or GMAIL_IMAP_USER)');
    if (!config.imap.pass) missing.push('PASS (or GMAIL_IMAP_PASS)');
    if (missing.length) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }
}

module.exports = { config, validate };
