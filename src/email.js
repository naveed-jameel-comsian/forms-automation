const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { config } = require('./config');
const logger = require('./logger');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const SUBJECT_RE = /confirm|activ|verify|valider|activate|inscription/i;
// Manual admin validation: the approval email arrives hours/days later.
const APPROVAL_RE = /approved|approval|activated|validé|valide|approuvé|approuve|accepted|accepté|accepte/i;
// Step 6 — primary link pattern from the spec.
const CONFIRM_LINK_RE = /https?:\/\/[^\s"'<>]+confirm[^\s"'<>]+/i;
// Secondary patterns for forums that word the link differently.
const FALLBACK_LINK_RE = /https?:\/\/[^\s"'<>]+(?:activ|valider|verify|activate|token|key=|login)[^\s"'<>]*/i;

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

function bodyOf(message) {
    return `${message.text || ''}\n${message.html || ''}`.replace(/&amp;/g, '&');
}

function sameHost(url, forumHost) {
    const h = hostOf(url);
    if (!h || !forumHost) return false;
    return h === forumHost || h.endsWith(`.${forumHost}`) || forumHost.endsWith(`.${h}`);
}

function extractLink(message, forumHost) {
    const body = bodyOf(message);
    const strip = (value) => value && value.replace(/[).,;]+$/, '');

    const primary = strip(body.match(CONFIRM_LINK_RE)?.[0]);
    if (primary) return primary;

    const urls = (body.match(/https?:\/\/[^\s"'<>]+/gi) || []).map(strip).filter(Boolean);

    const hostMatch = urls.find((u) => sameHost(u, forumHost) && FALLBACK_LINK_RE.test(u));
    if (hostMatch) return hostMatch;

    return strip(body.match(FALLBACK_LINK_RE)?.[0]) || null;
}

async function withInbox(fn) {
    const client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.port === 993,
        auth: { user: config.imap.user, pass: config.imap.pass },
        logger: false,
    });

    await client.connect();
    await client.mailboxOpen('INBOX');
    try {
        return await fn(client);
    } finally {
        await client.logout().catch(() => {});
    }
}

// Walk messages received since `since`; return the first truthy `matcher` result.
async function scanMessages(client, since, matcher, checked = new Set()) {
    const uids = await client.search(
        { since: new Date(since.getTime() - 60_000) },
        { uid: true },
    );

    for (const uid of (uids || []).slice(-100).reverse()) {
        if (checked.has(uid)) continue;
        checked.add(uid);

        const raw = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
        if (!raw?.source) continue;
        if (raw.internalDate && raw.internalDate < since) continue;

        const message = await simpleParser(raw.source);
        const hit = matcher(message);
        if (hit) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
            return hit;
        }
    }
    return null;
}

// Step 6 — watch the inbox for up to `timeoutMs` and return the confirmation link.
async function waitForConfirmationLink({ since, forumUrl, timeoutMs = config.emailTimeoutMs }) {
    const forumHost = hostOf(forumUrl);
    const deadline = Date.now() + timeoutMs;
    const checked = new Set();

    const matcher = (message) => {
        const subject = message.subject || '';
        const haystack = `${subject} ${message.from?.text || ''} ${message.text || ''}`;
        const relevant = SUBJECT_RE.test(subject) || (forumHost && haystack.includes(forumHost));
        if (!relevant) return null;
        return extractLink(message, forumHost);
    };

    return withInbox(async (client) => {
        logger.info('[email] watching inbox for confirmation email...');
        while (Date.now() < deadline) {
            const link = await scanMessages(client, since, matcher, checked);
            if (link) {
                logger.info('[email] confirmation link found');
                return link;
            }
            await delay(15_000);
        }
        return null;
    });
}

// Manual admin validation: one non-blocking pass looking for the approval email.
// Returns { link } when found (link may be null), or null when nothing matched yet.
async function scanForApprovalEmail({ since, forumUrl }) {
    const forumHost = hostOf(forumUrl);

    const matcher = (message) => {
        const subject = message.subject || '';
        const body = bodyOf(message);
        const fromHost = forumHost
            && `${subject} ${message.from?.text || ''} ${body}`.includes(forumHost);

        const approved = APPROVAL_RE.test(subject) || (fromHost && APPROVAL_RE.test(body));
        if (!approved) return null;

        return { link: extractLink(message, forumHost), subject };
    };

    return withInbox((client) => scanMessages(client, since, matcher));
}

module.exports = { waitForConfirmationLink, scanForApprovalEmail };
