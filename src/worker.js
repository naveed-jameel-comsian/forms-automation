const { config } = require('./config');
const supabase = require('./supabase');
const { launchBrowser, delay, rand } = require('./browser');
const { attemptRegistration, visitConfirmationLink } = require('./register');
const { waitForConfirmationLink, scanForApprovalEmail } = require('./email');
const logger = require('./logger');

const APPROVAL_STATUS = 'pending_admin_approval';

async function log(forum, { status, extra }) {
    await supabase.logAction(
        {
            forum_url: forum.lien_inscription,
            status: extra.status || null,
            error: extra.error || null,
            captcha_type: extra.captchaType || null,
            security_question: extra.securityQuestion || null,
            security_answer: extra.securityAnswer || null,
            attempt: extra.attempt,
        },
        status,
    );
}

// Steps 2-7 for a single forum, with up to config.maxAttempts tries.
async function processForum(browser, forum) {
    logger.info(`=== Forum ${forum.id} — ${forum.lien_inscription} ===`);
    await supabase.markInProgress(forum.id);

    let attempts = forum.inscription_attempts || 0;

    while (attempts < config.maxAttempts) {
        attempts++;
        logger.info(`[forum ${forum.id}] attempt ${attempts}/${config.maxAttempts}`);

        let result;
        try {
            result = await attemptRegistration(browser, forum);
        } catch (err) {
            result = { status: 'inscription_failed', error: err.message, securityQuestions: [] };
        }

        const firstQuestion = result.securityQuestions?.[0];
        const logExtra = {
            status: result.status,
            error: result.error,
            captchaType: result.captchaType,
            securityQuestion: firstQuestion?.question,
            securityAnswer: firstQuestion?.answer,
            attempt: attempts,
        };

        await supabase.setAttempts(forum.id, attempts);

        const passwordUpdate = result.password ? { mot_de_passe: result.password } : {};

        // Step 5 — account already exists.
        if (result.status === 'compte_preexistant') {
            await supabase.updateForum(forum.id, {
                inscription_status: 'compte_preexistant',
                inscription_attempts: attempts,
                ...passwordUpdate,
            });
            await log(forum, { status: 'success', extra: logExtra });
            logger.info(`[forum ${forum.id}] account already exists`);
            return;
        }

        // Manual admin validation — no instant email; the approval checker takes over.
        if (result.status === APPROVAL_STATUS) {
            await supabase.updateForum(forum.id, {
                inscription_status: APPROVAL_STATUS,
                inscription_attempts: attempts,
                ...passwordUpdate,
            });
            await log(forum, { status: 'success', extra: logExtra });
            logger.info(`[forum ${forum.id}] awaiting admin approval (watched for up to 7 days)`);
            return;
        }

        // Step 5 + 6 — submitted, now wait for the confirmation email.
        if (result.status === 'confirmation_pending') {
            await supabase.updateForum(forum.id, {
                inscription_status: 'confirmation_pending',
                inscription_attempts: attempts,
                ...passwordUpdate,
            });
            await log(forum, { status: 'success', extra: logExtra });
            logger.info(`[forum ${forum.id}] submitted, waiting for confirmation email`);

            const link = await waitForConfirmationLink({
                since: result.submittedAt || new Date(),
                forumUrl: forum.lien_inscription,
            });

            if (link) {
                const visited = await visitConfirmationLink(browser, link);
                if (visited) {
                    await supabase.updateForum(forum.id, {
                        inscription_status: 'inscrit',
                        date_inscription: new Date().toISOString(),
                        ...passwordUpdate,
                    });
                    await log(forum, {
                        status: 'success',
                        extra: { ...logExtra, status: 'inscrit' },
                    });
                    logger.info(`[forum ${forum.id}] confirmed and registered`);
                    return;
                }
            }

            // Email never arrived / link failed: leave as confirmation_pending, stop retrying.
            await log(forum, {
                status: 'error',
                extra: { ...logExtra, status: 'confirmation_pending', error: 'No confirmation email/link within window' },
            });
            logger.warn(`[forum ${forum.id}] no confirmation received`);
            return;
        }

        // Step 7 — failure path.
        await supabase.updateForum(forum.id, {
            inscription_attempts: attempts,
            inscription_error: result.error || 'Unknown error',
            ...passwordUpdate,
        });
        await log(forum, { status: 'error', extra: logExtra });
        logger.error(`[forum ${forum.id}] attempt ${attempts} failed: ${result.error}`);

        if (attempts >= config.maxAttempts) {
            await supabase.updateForum(forum.id, { inscription_status: 'inscription_failed' });
            logger.error(`[forum ${forum.id}] max attempts reached, marked inscription_failed`);
            return;
        }

        await delay(rand(5_000, 15_000));
    }
}

// Manual admin validation — re-check the inbox for forums awaiting approval.
// Runs on its own schedule so a 7-day wait never blocks the daily batch.
async function runApprovalCheck() {
    const forums = await supabase.fetchForumsByStatus(APPROVAL_STATUS);
    logger.info(`[approval] ${forums.length} forum(s) awaiting admin approval`);
    if (!forums.length) return;

    let browser = null;
    try {
        for (const forum of forums) {
            const startedAt = await supabase.findStatusLogTime(forum.lien_inscription, APPROVAL_STATUS)
                || new Date();

            let hit = null;
            try {
                hit = await scanForApprovalEmail({
                    since: startedAt,
                    forumUrl: forum.lien_inscription,
                });
            } catch (err) {
                logger.error(`[approval] inbox scan failed for forum ${forum.id}: ${err.message}`);
                continue;
            }

            if (hit) {
                if (hit.link) {
                    browser = browser || await launchBrowser(config.headless);
                    await visitConfirmationLink(browser, hit.link);
                }
                await supabase.updateForum(forum.id, {
                    inscription_status: 'inscrit',
                    date_inscription: new Date().toISOString(),
                });
                await log(forum, {
                    status: 'success',
                    extra: { status: 'inscrit', attempt: forum.inscription_attempts || 1 },
                });
                logger.info(`[forum ${forum.id}] admin approved${hit.link ? ' (activation link opened)' : ''}`);
                continue;
            }

            const elapsed = Date.now() - startedAt.getTime();
            if (elapsed > config.approvalTimeoutMs) {
                const error = 'Admin never approved after 7 days';
                await supabase.updateForum(forum.id, {
                    inscription_status: 'inscription_failed',
                    inscription_error: error,
                });
                await log(forum, {
                    status: 'error',
                    extra: { status: 'inscription_failed', error, attempt: forum.inscription_attempts || 1 },
                });
                logger.error(`[forum ${forum.id}] ${error}`);
                continue;
            }

            const hoursLeft = Math.round((config.approvalTimeoutMs - elapsed) / 3_600_000);
            logger.info(`[forum ${forum.id}] still waiting for approval (~${hoursLeft}h left)`);
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
    logger.info('[approval] check done');
}

// Step 8 — process the daily batch, one forum at a time with a long random gap.
async function runBatch() {
    logger.info(`[batch] starting at ${new Date().toISOString()}`);
    logger.info(`[batch] writing file logs to ${logger.file}`);
    const forums = await supabase.fetchPendingForums(config.dailyLimit);
    logger.info(`[batch] ${forums.length} pending forum(s)`);

    if (!forums.length) return;

    const browser = await launchBrowser(config.headless);
    try {
        for (let i = 0; i < forums.length; i++) {
            await processForum(browser, forums[i]);

            if (i < forums.length - 1) {
                const waitMin = rand(config.batchDelayMinMin, config.batchDelayMaxMin);
                logger.info(`[batch] waiting ${waitMin} min before the next forum`);
                await delay(waitMin * 60_000);
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
    logger.info('[batch] done');
}

module.exports = { runBatch, processForum, runApprovalCheck };
