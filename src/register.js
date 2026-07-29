const { Solver } = require('@2captcha/captcha-solver');
const { config } = require('./config');
const { createContext, humanClick, humanType, humanMouseWander, delay, rand } = require('./browser');
const { answerSecurityField, generatePasswordFromRules } = require('./claude');
const logger = require('./logger');

const solver = config.twoCaptchaKey ? new Solver(config.twoCaptchaKey) : null;
const MAX_PASSWORD_ATTEMPTS = 3;

// Step 3 — field selectors.
const USERNAME_SELECTORS = [
    'input[name*="user" i]',
    'input[name*="pseudo" i]',
    'input[name*="username" i]',
    'input[id*="user" i]',
    'input[id*="pseudo" i]',
];
const EMAIL_SELECTORS = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="mail" i]',
    'input[id*="email" i]',
];
const PASSWORD_SELECTOR = 'input[type="password"]';
const SUBMIT_SELECTORS = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button[name*="submit" i]',
    'input[name*="submit" i]',
    'button[name*="register" i]',
    'input[name*="register" i]',
];

const RESPONSE_PATTERNS = {
    compte_preexistant: [
        'already in use', 'already registered', 'already taken', 'already exists',
        'email exists', 'username taken', 'déjà utilisé', 'déjà utilisée',
        'déjà pris', 'déjà prise', 'existe déjà', 'déjà enregistré',
    ],
    // Forums where an administrator must approve the account before activation.
    pending_admin_approval: [
        'pending approval', 'pending admin', 'awaiting approval', 'awaiting admin',
        'account is pending', 'must be approved', 'needs to be approved',
        'notified when your account is approved', 'approved by an administrator',
        'administrateur doit valider', 'doit être validé', 'doit etre valide',
        'en attente de validation', "en attente d'approbation", 'en attente d’approbation',
        'validation par un administrateur', 'validé par un administrateur',
        'approuvé par un administrateur', 'sera validé', 'après validation',
    ],
    // Password policy rejections — retried with a Claude-generated password.
    password_rejected: [
        'password too short', 'mot de passe trop court', 'password is too short',
        'must contain uppercase', 'must contain lowercase', 'must contain a number',
        'must contain a special', 'must include uppercase', 'must include lowercase',
        'caractère spécial requis', 'caractere special requis',
        'majuscule', 'minuscule', 'special character', 'special characters',
        'au moins', 'at least', 'minimum', 'trop faible', 'too weak',
        'password requirements', 'exigences du mot de passe',
        'password must', 'le mot de passe doit', 'invalid password', 'mot de passe invalide',
        'password does not meet', 'ne respecte pas',
    ],
    failure: [
        'error', 'erreur', 'invalid', 'invalide', 'incorrect', 'not match',
        'ne correspond', 'trop court', 'too short', 'required', 'obligatoire',
        'captcha', 'failed', 'échoué',
    ],
};

function generatePassword() {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const special = '!@#$%^&*?';
    const all = upper + lower + numbers + special;

    let password = '';
    // Guarantee at least one of each required type
    password += upper[Math.floor(Math.random() * upper.length)];
    password += lower[Math.floor(Math.random() * lower.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];

    // Fill remaining 8 characters randomly
    for (let i = 0; i < 8; i++) {
        password += all[Math.floor(Math.random() * all.length)];
    }

    // Shuffle to avoid predictable pattern (upper always first)
    return password.split('').sort(() => Math.random() - 0.5).join('');
}

async function firstVisible(page, selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
        const locator = page.locator(selector).first();
        if (await locator.count().catch(() => 0)) {
            if (await locator.isVisible().catch(() => false)) return locator;
        }
    }
    return null;
}

async function fillField(page, selectors, value) {
    if (!value) return false;
    const locator = await firstVisible(page, selectors);
    if (!locator) return false;
    await humanType(page, locator, value);
    return true;
}

// Step 3 — password + optional confirmation field (fill every visible password input).
async function fillPasswords(page, value) {
    if (!value) return 0;
    const inputs = page.locator(PASSWORD_SELECTOR);
    const count = await inputs.count().catch(() => 0);
    let filled = 0;
    for (let i = 0; i < count; i++) {
        const locator = inputs.nth(i);
        if (await locator.isVisible().catch(() => false)) {
            await humanType(page, locator, value);
            filled++;
        }
    }
    return filled;
}

function isPasswordRejected(text) {
    const hay = (text || '').toLowerCase();
    return RESPONSE_PATTERNS.password_rejected.some((p) => hay.includes(p));
}

// Pull password-related rule text from the page for Claude.
function extractPasswordRules(text) {
    const lines = String(text || '')
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);

    const ruleLines = lines.filter((line) => {
        const lower = line.toLowerCase();
        return /pass|mot de passe|password|majuscule|minuscule|spécial|special|caractère|character|chiffre|digit|number|longueur|length|minimum|au moins|uppercase|lowercase/i
            .test(lower);
    });

    const rules = (ruleLines.length ? ruleLines : lines)
        .join(' | ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);

    return rules || 'Password was rejected. Must be stronger.';
}

// Step 4 — collect text inputs that are not username/email/password, with nearby text.
async function collectSecurityFields(page) {
    return page.evaluate(() => {
        const nonQuestion = /user|pseudo|username|email|mail|pass|captch|confirm_code|vc_|securitycode|token|csrf/i;
        const results = [];
        const inputs = Array.from(document.querySelectorAll('input, textarea'));
        let idx = 0;

        for (const el of inputs) {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            const tag = el.tagName.toLowerCase();
            const isTextual = tag === 'textarea'
                || ['text', 'search', 'tel', 'number', ''].includes(type);
            if (!isTextual) continue;

            const nameId = `${el.name || ''} ${el.id || ''}`;
            if (nonQuestion.test(nameId)) continue;

            const texts = [];
            if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) texts.push(label.innerText);
            }
            const wrapLabel = el.closest('label');
            if (wrapLabel) texts.push(wrapLabel.innerText);

            let node = el.parentElement;
            let hops = 0;
            while (node && hops < 3) {
                const clone = node.cloneNode(true);
                clone.querySelectorAll('input, textarea, select, button').forEach((n) => n.remove());
                const t = (clone.innerText || '').trim();
                if (t) texts.push(t);
                node = node.parentElement;
                hops++;
            }
            if (el.placeholder) texts.push(el.placeholder);

            const text = Array.from(new Set(texts.map((t) => t.trim()).filter(Boolean)))
                .join(' ')
                .replace(/\s+/g, ' ')
                .slice(0, 400);
            if (!text) continue;

            el.setAttribute('data-auto-idx', String(idx));
            results.push({ idx, text, name: el.name || '', id: el.id || '' });
            idx++;
        }
        return results;
    });
}

// Step 4 — for each candidate, ask Claude and fill when an answer comes back.
async function handleSecurityFields(page) {
    const handled = [];
    let candidates = [];
    try {
        candidates = await collectSecurityFields(page);
    } catch {
        return handled;
    }
    if (!candidates.length) return handled;

    const title = await page.title().catch(() => '');
    const content = (await page.evaluate(() => document.body.innerText).catch(() => '') || '')
        .replace(/\s+/g, ' ')
        .slice(0, 500);

    for (const field of candidates) {
        let answer = null;
        try {
            answer = await answerSecurityField({ text: field.text, title, content });
        } catch (err) {
            logger.error(`[claude] failed for field ${field.name || field.id}: ${err.message}`);
            continue;
        }
        if (!answer) continue;

        const locator = page.locator(`[data-auto-idx="${field.idx}"]`).first();
        if (await locator.isVisible().catch(() => false)) {
            await humanType(page, locator, answer);
            handled.push({ question: field.text, answer });
        }
    }
    return handled;
}

// Best-effort image captcha via 2captcha (non-fatal if absent).
async function trySolveImageCaptcha(page) {
    if (!solver) return null;
    const input = await firstVisible(page, [
        'input[name*="captch" i]', 'input[id*="captch" i]',
        'input[name="confirm_code"]', 'input[name*="vc" i]',
    ]);
    if (!input) return null;

    const img = page.locator('img[src*="captch" i], img[alt*="captch" i], .captcha img, dd.captcha img').first();
    if (!(await img.count().catch(() => 0))) return null;

    try {
        const base64 = (await img.screenshot()).toString('base64');
        const result = await solver.imageCaptcha({ body: base64, min_len: 1, max_len: 8 });
        const code = String(result.data || '').trim();
        if (code) {
            await humanType(page, input, code);
            return 'image';
        }
    } catch (err) {
        logger.error(`[captcha] image solve failed: ${err.message}`);
    }
    return null;
}

async function clickSubmit(page) {
    const submit = await firstVisible(page, SUBMIT_SELECTORS);
    if (!submit) throw new Error('No submit button found on the registration form');
    await humanClick(page, submit);
}

// Step 5 — classify the post-submit page.
function analyzeResponse(text) {
    const hay = (text || '').toLowerCase();
    if (RESPONSE_PATTERNS.compte_preexistant.some((p) => hay.includes(p))) {
        return 'compte_preexistant';
    }
    // Checked before the generic failure words: an approval notice is not an error.
    if (RESPONSE_PATTERNS.pending_admin_approval.some((p) => hay.includes(p))) {
        return 'pending_admin_approval';
    }
    if (isPasswordRejected(hay)) {
        return 'password_rejected';
    }
    if (RESPONSE_PATTERNS.failure.some((p) => hay.includes(p))) {
        return 'inscription_failed';
    }
    return 'confirmation_pending';
}

async function refillCoreFields(page, forum, password) {
    await fillField(page, USERNAME_SELECTORS, forum.pseudonyme_genere);
    await fillField(page, EMAIL_SELECTORS, forum.email_utilise);
    return fillPasswords(page, password);
}

// Steps 2-5 — one registration attempt. Returns a structured result.
async function attemptRegistration(browser, forum) {
    const { context, fingerprint } = await createContext(browser);
    const page = await context.newPage();
    let password = generatePassword();
    const result = {
        status: 'inscription_failed',
        error: null,
        captchaType: null,
        securityQuestions: [],
        fingerprint,
        submittedAt: null,
        password,
        passwordAttempts: 0,
    };

    try {
        await page.goto(forum.lien_inscription, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanMouseWander(page);
        await delay(rand(800, 2000));

        logger.info(`[password] generated for forum ${forum.id}`);
        const gotUser = await fillField(page, USERNAME_SELECTORS, forum.pseudonyme_genere);
        const gotEmail = await fillField(page, EMAIL_SELECTORS, forum.email_utilise);
        const gotPass = await fillPasswords(page, password);

        if (!gotUser && !gotEmail && !gotPass) {
            result.error = 'No recognizable registration fields on the page';
            return result;
        }

        result.securityQuestions = await handleSecurityFields(page);

        for (let pwdAttempt = 1; pwdAttempt <= MAX_PASSWORD_ATTEMPTS; pwdAttempt++) {
            result.passwordAttempts = pwdAttempt;
            result.password = password;

            result.captchaType = await trySolveImageCaptcha(page) || result.captchaType;

            await delay(rand(400, 1200));
            result.submittedAt = new Date();
            await clickSubmit(page);
            await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
            await delay(3000);

            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            result.status = analyzeResponse(bodyText);

            if (result.status !== 'password_rejected') {
                if (result.status === 'inscription_failed') {
                    result.error = bodyText.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown error';
                }
                return result;
            }

            result.error = bodyText.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Password rejected';
            logger.warn(`[password] rejected on attempt ${pwdAttempt}/${MAX_PASSWORD_ATTEMPTS}`);

            if (pwdAttempt >= MAX_PASSWORD_ATTEMPTS) {
                result.status = 'inscription_failed';
                return result;
            }

            const detectedRules = extractPasswordRules(bodyText);
            try {
                password = await generatePasswordFromRules(detectedRules);
                result.password = password;
                logger.info(`[password] Claude generated a new password for attempt ${pwdAttempt + 1}`);
            } catch (err) {
                logger.error(`[password] Claude generation failed: ${err.message}`);
                password = generatePassword();
                result.password = password;
                logger.info('[password] fell back to local generator');
            }

            // If the form is gone after submit, reload and refill everything.
            const stillOnForm = await page.locator(PASSWORD_SELECTOR).first().isVisible().catch(() => false);
            if (!stillOnForm) {
                await page.goto(forum.lien_inscription, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(rand(800, 1600));
                await refillCoreFields(page, forum, password);
                result.securityQuestions = await handleSecurityFields(page);
            } else {
                await fillPasswords(page, password);
            }
        }

        return result;
    } catch (err) {
        result.status = 'inscription_failed';
        result.error = err.message;
        return result;
    } finally {
        await context.close().catch(() => {});
    }
}

// Step 6 — open the confirmation link in a fresh page.
async function visitConfirmationLink(browser, link) {
    const { context } = await createContext(browser);
    const page = await context.newPage();
    try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(2000);
        return true;
    } catch (err) {
        logger.error(`[confirm] failed to open link: ${err.message}`);
        return false;
    } finally {
        await context.close().catch(() => {});
    }
}

module.exports = {
    attemptRegistration,
    visitConfirmationLink,
    analyzeResponse,
    generatePassword,
    isPasswordRejected,
};
