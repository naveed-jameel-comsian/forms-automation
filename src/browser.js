const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];

// Step 2 — rotate user-agents (Chrome, Firefox, Safari) and screen resolutions.
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
];

async function launchBrowser(headless = true) {
    return chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled'],
    });
}

// Fresh, randomized fingerprint per forum.
async function createContext(browser) {
    const userAgent = pick(USER_AGENTS);
    const viewport = pick(VIEWPORTS);
    const context = await browser.newContext({
        userAgent,
        viewport,
        locale: 'fr-FR',
        deviceScaleFactor: 1,
    });
    return { context, fingerprint: { userAgent, viewport } };
}

// Move the mouse around a little before interacting, like a person would.
async function humanMouseWander(page) {
    const size = page.viewportSize() || { width: 1366, height: 768 };
    const moves = rand(2, 4);
    for (let i = 0; i < moves; i++) {
        await page.mouse.move(rand(0, size.width), rand(0, size.height), { steps: rand(4, 10) });
        await delay(rand(80, 240));
    }
}

async function humanClick(page, locator) {
    try {
        const box = await locator.boundingBox();
        if (box) {
            await humanMouseWander(page);
            await page.mouse.move(
                box.x + box.width / 2 + rand(-4, 4),
                box.y + box.height / 2 + rand(-3, 3),
                { steps: rand(6, 14) },
            );
            await delay(rand(60, 180));
        }
    } catch {
        // Fall back to a plain click if geometry is unavailable.
    }
    await locator.click({ timeout: 15000 });
}

// Type with a random 50-150ms pause between keystrokes — Step 2.
async function humanType(page, locator, text) {
    await humanClick(page, locator);
    await locator.fill('');
    for (const char of String(text)) {
        await locator.pressSequentially(char, { delay: rand(50, 150) });
    }
}

module.exports = {
    launchBrowser,
    createContext,
    humanClick,
    humanType,
    humanMouseWander,
    delay,
    rand,
    pick,
};
