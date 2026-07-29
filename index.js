const cron = require('node-cron');
const { config, validate } = require('./src/config');
const { runBatch, runApprovalCheck } = require('./src/worker');
const logger = require('./src/logger');

validate();

// `node index.js run`       -> run the registration batch once now and exit.
// `node index.js approvals` -> run the admin-approval inbox check once and exit.
// `node index.js`           -> schedule the daily batch + approval checker.
const args = process.argv.slice(2);
const runNow = args.includes('run') || args.includes('--now');
const approvalsNow = args.includes('approvals') || args.includes('--approvals');

function schedule(expression, label, task) {
    if (!cron.validate(expression)) {
        throw new Error(`Invalid cron expression for ${label}: ${expression}`);
    }
    cron.schedule(
        expression,
        async () => {
            try {
                await task();
            } catch (err) {
                logger.error(`[cron] ${label} failed:`, err);
            }
        },
        { timezone: config.cronTimezone },
    );
    logger.info(`[cron] ${label} scheduled "${expression}" (${config.cronTimezone})`);
}

async function main() {
    logger.info(`[app] file logger ready: ${logger.file}`);

    if (approvalsNow) {
        await runApprovalCheck();
        process.exit(0);
    }

    if (runNow) {
        await runBatch();
        process.exit(0);
    }

    schedule(config.cronSchedule, 'registration batch', runBatch);
    schedule(config.approvalCron, 'admin approval check', runApprovalCheck);

    logger.info('[app] running. One-off commands: `node index.js run`, `node index.js approvals`');
}

main().catch((err) => {
    logger.error(err);
    process.exit(1);
});
