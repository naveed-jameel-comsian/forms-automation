const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { config } = require('./config');
const logger = require('./logger');

const client = createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false },
    // Node < 22 has no native WebSocket; supabase-realtime needs one at init time.
    realtime: { transport: ws },
});

const FORUMS = config.tables.forums;
const LOGS = config.tables.logs;

const FORUM_COLUMNS = 'id, lien_inscription, pseudonyme_genere, email_utilise, mot_de_passe, inscription_status, inscription_attempts';

// Step 1 — read up to `limit` forums that still need to be processed.
async function fetchPendingForums(limit = config.dailyLimit) {
    const { data, error } = await client
        .from(FORUMS)
        .select(FORUM_COLUMNS)
        .eq('inscription_status', 'pending')
        .limit(limit);

    if (error) throw new Error(`Supabase fetchPendingForums failed: ${error.message}`);
    return data || [];
}

async function fetchForumsByStatus(status, limit = config.approvalBatchLimit) {
    const { data, error } = await client
        .from(FORUMS)
        .select(FORUM_COLUMNS)
        .eq('inscription_status', status)
        .limit(limit);

    if (error) throw new Error(`Supabase fetchForumsByStatus(${status}) failed: ${error.message}`);
    return data || [];
}

// Step 1 — mark a forum as in_progress as soon as we start it.
async function markInProgress(id) {
    await updateForum(id, { inscription_status: 'in_progress' });
}

// When did this forum first enter the given status? Read from the log trail so we
// do not need an extra timestamp column on the forums table.
async function findStatusLogTime(forumUrl, status) {
    const { data, error } = await client
        .from(LOGS)
        .select('executed_at')
        .eq('details->>forum_url', forumUrl)
        .eq('details->>status', status)
        .order('executed_at', { ascending: true })
        .limit(1);

    if (error) {
        logger.error(`[supabase] findStatusLogTime failed: ${error.message}`);
        return null;
    }
    const value = data?.[0]?.executed_at;
    return value ? new Date(value) : null;
}

async function updateForum(id, fields) {
    const { error } = await client.from(FORUMS).update(fields).eq('id', id);
    if (error) throw new Error(`Supabase updateForum failed: ${error.message}`);
}

async function setAttempts(id, attempts) {
    await updateForum(id, { inscription_attempts: attempts });
}

// Step 7 — structured log line into agent_seo_logs.
async function logAction(details, status) {
    const row = {
        action_type: 'forum_registration',
        details,
        status,
        executed_at: new Date().toISOString(),
    };
    const { error } = await client.from(LOGS).insert(row);
    if (error) {
        // Logging must never crash the worker.
        logger.error(`[supabase] failed to write log: ${error.message}`);
    }
}

module.exports = {
    client,
    fetchPendingForums,
    fetchForumsByStatus,
    findStatusLogTime,
    markInProgress,
    updateForum,
    setAttempts,
    logAction,
};
