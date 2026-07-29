const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function stamp() {
    return new Date().toISOString();
}

function formatArgs(args) {
    return args.map((arg) => {
        if (arg instanceof Error) {
            return `${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
        }
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');
}

function write(level, args) {
    const line = `[${stamp()}] [${level}] ${formatArgs(args)}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
        // Never crash the app because of logging.
        process.stderr.write(`[logger] failed to write log: ${err.message}\n`);
    }

    if (level === 'ERROR') {
        console.error(...args);
    } else if (level === 'WARN') {
        console.warn(...args);
    } else {
        console.log(...args);
    }
}

const logger = {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    debug: (...args) => write('DEBUG', args),
    file: LOG_FILE,
};

module.exports = logger;
