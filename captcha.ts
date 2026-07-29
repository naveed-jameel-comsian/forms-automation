/**
 * Captcha solving service — reCAPTCHA v2/Enterprise grid, hCaptcha, Arkose.
 *
 * Grid approach (from working reference project):
 *   1. Find checkbox anchor iframe → click checkbox
 *   2. Wait for bframe (grid challenge) to appear
 *   3. Extract grid image via canvas → send to 2captcha solver.grid()
 *   4. Click returned tile positions → click Verify
 *   5. Repeat up to 8 rounds
 *
 * Frame finding strategy:
 *   LinkedIn can nest the reCAPTCHA inside iframe[title="Security verification"].
 *   We poll page.frames() (returns ALL frames regardless of nesting) AND fall back
 *   to direct DOM selectors so both nested and top-level layouts are handled.
 */
import { Solver } from "@2captcha/captcha-solver";
import axios from "axios";
import type { Page, Frame } from "playwright";

const capsolverApiKey = "3c1268b7eaff51b46b97cb801a6a2e16"
// ─── Frame polling helpers ─────────────────────────────────────────────────────

/**
 * Find the reCAPTCHA anchor frame (the one with the checkbox).
 *
 * Reference project: page.waitForSelector('iframe[title="reCAPTCHA"]') works because
 * their reCAPTCHA is directly in the main page DOM.
 *
 * LinkedIn: reCAPTCHA is nested one level deeper:
 *   main page → iframe[title="Security verification"] → iframe[title="reCAPTCHA"]
 *
 * We use waitForSelector (not $) at each level so we WAIT for the iframe to render,
 * exactly like the reference project does.
 */
/** Match iframe URL `k=` param to the widget site key (avoids wrong anchor when multiple reCAPTCHAs exist). */
function frameMatchesSiteKey(frameUrl: string, siteKey: string): boolean {
  if (!siteKey) return true;
  if (frameUrl.includes(siteKey)) return true;
  try {
    const m = frameUrl.match(/[?&]k=([^&]+)/);
    if (m) return decodeURIComponent(m[1]) === siteKey;
  } catch { /* ignore */ }
  return false;
}

async function frameHasCheckbox(f: Frame): Promise<boolean> {
  try {
    return await f.evaluate(`(function() {
      return !!document.querySelector(
        '#recaptcha-anchor, span.recaptcha-checkbox, .rc-anchor-checkbox[role="checkbox"], [role="checkbox"].recaptcha-checkbox'
      );
    })()`);
  } catch {
    return false;
  }
}

function getSiteKeyFromUrl(url: string): string {
  try {
    const m = url.match(/[?&]k=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

/**
 * Find the anchor frame that actually contains the checkbox DOM.
 * When LinkedIn loads several widgets (e.g. invisible + visible), the first
 * `iframe[title="reCAPTCHA"]` may be a token/alert shell without `#recaptcha-anchor`.
 * Passing `siteKey` (from detectCaptcha / visible iframe `k=` param) selects the correct frame.
 */
/** Order anchor frames: prefer URL matching siteKey, then try other widgets (visible challenge may use a different k= than detection). */
function orderAnchorFramesForKey(anchorUrls: Frame[], siteKey?: string): Frame[] {
  if (!siteKey) return anchorUrls;
  const keyed = anchorUrls.filter((fr) => frameMatchesSiteKey(fr.url(), siteKey));
  const rest = anchorUrls.filter((fr) => !frameMatchesSiteKey(fr.url(), siteKey));
  return [...keyed, ...rest];
}

async function waitForAnchorFrame(page: Page, timeoutMs = 15_000, siteKey?: string): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const anchorUrls = page.frames().filter((fr) => {
      const u = fr.url();
      return (u.includes("google.com/recaptcha") || u.includes("recaptcha.net/recaptcha")) &&
             u.includes("/anchor");
    });
    const pool = orderAnchorFramesForKey(anchorUrls, siteKey);

    for (const fr of pool) {
      if (await frameHasCheckbox(fr)) {
        console.log(
          `[captcha] Anchor frame resolved (${siteKey ? `prefer k=${siteKey.slice(0, 8)}…` : "no key filter"})`,
        );
        return fr;
      }
    }

    // Nested: Security verification → one or more reCAPTCHA iframes (do not take only the first).
    try {
      const sec = await page.$('iframe[title="Security verification"]');
      if (sec) {
        const secFrame = await sec.contentFrame();
        if (secFrame) {
          const innerHandles = await secFrame.$$('iframe[title="reCAPTCHA"]');
          for (const h of innerHandles) {
            const src = await h.getAttribute("src");
            if (siteKey && src && !frameMatchesSiteKey(src, siteKey)) continue;
            const cf = await h.contentFrame();
            if (cf && await frameHasCheckbox(cf)) {
              console.log("[captcha] Anchor frame found via security iframe (matched checkbox / site key)");
              return cf;
            }
          }
          if (siteKey) {
            for (const h of innerHandles) {
              const cf = await h.contentFrame();
              if (cf && await frameHasCheckbox(cf)) {
                console.log("[captcha] Anchor frame via security iframe (fallback: any widget with checkbox)");
                return cf;
              }
            }
          }
        }
      }
    } catch { /* ignore */ }

    // Main page: every reCAPTCHA iframe by handle order, not only the first.
    try {
      for (const h of await page.$$('iframe[title="reCAPTCHA"]')) {
        const src = await h.getAttribute("src");
        if (siteKey && src && !frameMatchesSiteKey(src, siteKey)) continue;
        const cf = await h.contentFrame();
        if (cf && await frameHasCheckbox(cf)) {
          console.log("[captcha] Anchor frame found directly in main page (matched checkbox / site key)");
          return cf;
        }
      }
      if (siteKey) {
        for (const h of await page.$$('iframe[title="reCAPTCHA"]')) {
          const cf = await h.contentFrame();
          if (cf && await frameHasCheckbox(cf)) {
            console.log("[captcha] Anchor frame found in main page (fallback: any widget with checkbox)");
            return cf;
          }
        }
      }
    } catch { /* ignore */ }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.warn(
    "[captcha] Anchor frame not found after timeout. All frames:",
    page.frames().map((f) => f.url()).join(" | ") || "(none)",
  );
  return null;
}

/** Poll until the reCAPTCHA bframe (grid challenge) appears, or timeout. */
async function waitForBframe(page: Page, timeoutMs = 10_000, siteKey?: string): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // 1. page.frames() — handles nested bframes
    const bframes = page.frames().filter((f) => {
      const u = f.url();
      return (u.includes("google.com/recaptcha") || u.includes("recaptcha.net/recaptcha")) &&
             u.includes("/bframe");
    });
    const byUrl = siteKey
      ? [...bframes.filter((f) => frameMatchesSiteKey(f.url(), siteKey)), ...bframes.filter((f) => !frameMatchesSiteKey(f.url(), siteKey))]
      : bframes;
    if (byUrl.length > 0) return byUrl[0];

    // 2. Direct DOM selector
    try {
      const handles = await page.$$('iframe[src*="recaptcha"][src*="bframe"]');
      for (const h of handles) {
        const src = await h.getAttribute("src");
        if (siteKey && src && !frameMatchesSiteKey(src, siteKey)) continue;
        const f = await h.contentFrame();
        if (f) return f;
      }
      if (siteKey) {
        for (const h of handles) {
          const f = await h.contentFrame();
          if (f) return f;
        }
      }
    } catch { /* ignore */ }

    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** True once the bframe is gone or the checkbox shows checked. */
async function isRecaptchaPassed(page: Page, siteKey?: string): Promise<boolean> {
  // No bframe = grid dismissed = likely passed
  const bframeExists = page.frames().some((f) => {
    const u = f.url();
    if (siteKey && !frameMatchesSiteKey(u, siteKey)) return false;
    return (u.includes("google.com/recaptcha") || u.includes("recaptcha.net/recaptcha")) &&
           u.includes("/bframe");
  });
  if (!bframeExists) {
    // Also verify via DOM (bframe can linger briefly as about:blank)
    try {
      const hs = await page.$$('iframe[src*="recaptcha"][src*="bframe"]');
      const h = siteKey
        ? await (async () => {
            for (const handle of hs) {
              const src = await handle.getAttribute("src");
              if (src && frameMatchesSiteKey(src, siteKey)) return handle;
            }
            return null;
          })()
        : hs[0] ?? null;
      if (!h) return true;
    } catch { return true; }
  }

  // Check the checkbox state in the anchor frame
  const anchor = page.frames().find((f) => {
    const u = f.url();
    if (siteKey && !frameMatchesSiteKey(u, siteKey)) return false;
    return (u.includes("google.com/recaptcha") || u.includes("recaptcha.net/recaptcha")) &&
           u.includes("/anchor");
  });
  if (!anchor) return false;

  try {
    const checked = await anchor.evaluate(`(function() {
      var el = document.querySelector('.recaptcha-checkbox-checked, [aria-checked="true"]');
      return !!el;
    })()`);
    return !!checked;
  } catch {
    return false;
  }
}

// ─── Capsolver (fallback for Arkose / hCaptcha) ───────────────────────────────

const CAPSOLVER_URL = "https://api.capsolver.com";

async function capsolverCreateTask(apiKey: string, task: Record<string, unknown>): Promise<string> {
  const res = await axios.post(`${CAPSOLVER_URL}/createTask`, { clientKey: apiKey, task });
  const data = res.data as { errorId: number; taskId?: string; errorDescription?: string };
  if (data.errorId !== 0) throw new Error(`[capsolver] ${data.errorDescription}`);
  return data.taskId!;
}

async function capsolverGetResult(apiKey: string, taskId: string, maxWaitMs = 120_000): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const res = await axios.post(`${CAPSOLVER_URL}/getTaskResult`, { clientKey: apiKey, taskId });
    const data = res.data as {
      errorId: number; status: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
      errorDescription?: string;
    };
    if (data.errorId !== 0) throw new Error(`[capsolver] ${data.errorDescription}`);
    if (data.status === "ready") return data.solution?.gRecaptchaResponse ?? data.solution?.token ?? "";
  }
  throw new Error("[capsolver] Timeout");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CaptchaServiceOptions {
  capsolverApiKey?: string;
  twocaptchaApiKey?: string;
}

/** Options for physical grid solving — pass the same site key returned by page captcha detection. */
export interface SolveRecaptchaGridOptions {
  /** Iframe URL contains `k=` — required when multiple reCAPTCHA anchors exist on one page. */
  siteKey?: string;
}

export class CaptchaService {
  private solver: Solver | null = null;

  constructor(private readonly opts: CaptchaServiceOptions) {
    if (opts.twocaptchaApiKey) {
      this.solver = new Solver(opts.twocaptchaApiKey, 300);
    }
  }

  private wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════════════════
  // reCAPTCHA v2 / Enterprise — grid interaction (from working reference)
  // ═══════════════════════════════════════════════════════════════════════════

  async solveRecaptchaGrid(page: Page, gridOpts?: SolveRecaptchaGridOptions): Promise<boolean> {
    if (!this.solver) throw new Error("[captcha] 2captcha not initialised — TWOCAPTCHA_API_KEY missing");

    try {
      // Give LinkedIn's security dialog a moment to fully render
      await this.wait(1_500);

      // ── Step 1: click checkbox — same idea as portal-nc/src/services/captcha.js:
      // wait for iframe[title="reCAPTCHA"], click span.recaptcha-checkbox-unchecked,
      // without filtering by site key first (LinkedIn mixes invisible k= + visible grid k=).
      const clickedDomFirst = await this.clickRecaptchaCheckboxDomFirst(page);
      let activeSiteKey = clickedDomFirst.siteKey || gridOpts?.siteKey;
      if (!clickedDomFirst.clicked) {
        const anchor = await waitForAnchorFrame(page, 10_000, gridOpts?.siteKey);
        if (!anchor) return false;
        const anchorKey = getSiteKeyFromUrl(anchor.url());
        if (anchorKey) activeSiteKey = anchorKey;

        const clicked = await this.clickCheckboxInFrame(anchor);
        if (!clicked) {
          console.warn("[captcha] Checkbox element not found inside anchor frame");
          return false;
        }
        console.log("[captcha] Checkbox clicked (anchor fallback path)");
      }

      await this.wait(2_000);

      // ── Step 2: check if captcha passed immediately (checkbox-only) ───────
      if (await isRecaptchaPassed(page, activeSiteKey)) {
        console.log("[captcha] ✅ Checkbox alone passed captcha");
        return true;
      }

      // ── Step 3: wait for grid challenge ───────────────────────────────────
      const gridAppeared = await this.pollForGridOrPass(page, 12_000, activeSiteKey);
      if (!gridAppeared) {
        console.log("[captcha] ✅ Captcha passed while waiting for grid");
        return true;
      }

      console.log("[captcha] Grid challenge appeared — solving");
      return await this.solveGrid(page, activeSiteKey);

    } catch (err) {
      console.error("[captcha] solveRecaptchaGrid error:", (err as Error).message);
      return false;
    }
  }

  // ── Checkbox click ──────────────────────────────────────────────────────────

  /**
   * portal-nc/captcha.js pattern: iframe[title="reCAPTCHA"] → click
   * `span.recaptcha-checkbox-unchecked`. No site-key filter — avoids picking the
   * invisible Enterprise widget while the interactive challenge uses another key.
   */
  private async clickRecaptchaCheckboxDomFirst(page: Page): Promise<{ clicked: boolean; siteKey?: string }> {
    const tryClick = async (anchor: Frame): Promise<{ clicked: boolean; siteKey?: string }> => {
      try {
        const ok = await anchor.evaluate(`(function() {
          var cb = document.querySelector('span.recaptcha-checkbox-unchecked') ||
                   document.querySelector('#recaptcha-anchor') ||
                   document.querySelector('.rc-anchor-checkbox[role="checkbox"]') ||
                   document.querySelector('[role="checkbox"].recaptcha-checkbox');
          if (cb) { cb.click(); return true; }
          return false;
        })()`);
        if (ok) {
          const key = getSiteKeyFromUrl(anchor.url());
          return { clicked: true, siteKey: key || undefined };
        }
        return { clicked: false };
      } catch {
        return { clicked: false };
      }
    };

    try {
      const sec = await page.$('iframe[title="Security verification"]');
      if (sec) {
        const secFrame = await sec.contentFrame();
        if (secFrame) {
          await secFrame.waitForSelector('iframe[title="reCAPTCHA"]', { state: "attached", timeout: 8_000 }).catch(() => {});
          for (const h of await secFrame.$$('iframe[title="reCAPTCHA"]')) {
            const cf = await h.contentFrame();
            const hit = cf ? await tryClick(cf) : { clicked: false };
            if (hit.clicked) {
              console.log("[captcha] Checkbox clicked (DOM-first, security iframe)");
              return hit;
            }
          }
        }
      }
    } catch { /* ignore */ }

    try {
      await page.waitForSelector('iframe[title="reCAPTCHA"]', { state: "attached", timeout: 10_000 });
      for (const h of await page.$$('iframe[title="reCAPTCHA"]')) {
        const cf = await h.contentFrame();
        const hit = cf ? await tryClick(cf) : { clicked: false };
        if (hit.clicked) {
          console.log("[captcha] Checkbox clicked (DOM-first, main page)");
          return hit;
        }
      }
    } catch { /* ignore */ }

    return { clicked: false };
  }

  private async clickCheckboxInFrame(anchor: Frame): Promise<boolean> {
    try {
      await anchor.waitForSelector(
        "#recaptcha-anchor, span.recaptcha-checkbox-unchecked, .rc-anchor-checkbox[role=\"checkbox\"]",
        { state: "attached", timeout: 12_000 },
      );
    } catch {
      /* proceed — older DOM or spinner-only state */
    }

    // Exact same approach as reference project — evaluate JS click inside the frame
    try {
      const clicked = await anchor.evaluate(`(function() {
        var cb = document.querySelector('#recaptcha-anchor') ||
                 document.querySelector('span.recaptcha-checkbox-unchecked') ||
                 document.querySelector('.rc-anchor-checkbox[role="checkbox"]') ||
                 document.querySelector('[role="checkbox"].recaptcha-checkbox');
        if (cb) { cb.click(); return true; }
        return false;
      })()`);
      if (clicked) {
        console.log("[captcha] Checkbox clicked (evaluate)");
        return true;
      }
    } catch (err) {
      console.warn("[captcha] evaluate click failed:", (err as Error).message);
    }

    // Fallback: Playwright locator click
    for (const sel of [
      "#recaptcha-anchor",
      "span.recaptcha-checkbox-unchecked",
      ".rc-anchor-checkbox",
      ".recaptcha-checkbox",
      '[role="checkbox"]',
    ]) {
      try {
        const el = anchor.locator(sel).first();
        if ((await el.count()) > 0) {
          await el.click({ delay: 60, timeout: 5_000 });
          console.log(`[captcha] Checkbox clicked via locator "${sel}"`);
          return true;
        }
      } catch { /* try next */ }
    }

    // Diagnosis: log what IDs exist in the frame
    try {
      const info = await anchor.evaluate(`(function() {
        var ids = Array.from(document.querySelectorAll('[id]')).map(function(el){ return el.id; }).slice(0, 20);
        return { ids: ids, bodyLen: document.body ? document.body.innerHTML.length : 0 };
      })()`);
      console.warn("[captcha] Anchor frame IDs (checkbox not found):", info);
    } catch { /* ignore */ }

    return false;
  }

  // ── Grid / pass detection ───────────────────────────────────────────────────

  private async pollForGridOrPass(page: Page, timeoutMs: number, siteKey?: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isRecaptchaPassed(page, siteKey)) return false;   // passed without grid
      const bframe = await waitForBframe(page, 100, siteKey).catch(() => null);
      if (bframe) return true;                            // grid appeared
      await this.wait(500);
    }
    const bframe = await waitForBframe(page, 100, siteKey).catch(() => null);
    return !!bframe;
  }

  private async waitForPassed(page: Page, timeoutMs = 15_000, siteKey?: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isRecaptchaPassed(page, siteKey)) return true;
      await this.wait(500);
    }
    return false;
  }

  private async isChallengeExpired(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      if (!frame.url().includes("recaptcha")) continue;
      try {
        const exp = await frame.evaluate(
          `(function(){ var t=document.body?document.body.innerText:''; return /expired|check the checkbox again/i.test(t); })()`
        );
        if (exp) return true;
      } catch { /* frame detached */ }
    }
    return false;
  }

  // ── Image extraction (injected into bframe) ─────────────────────────────────

  private async injectParamsExtractor(bframe: Frame): Promise<void> {
    await bframe.evaluate(`(function() {
      window.getCaptchaParams = function() {
        var imgSels = [
          '.rc-image-tile-wrapper img',
          '.rc-imageselect-payload img',
          '.rc-imageselect-target img',
          "img[src*='payload']",
          "img[src*='image']",
        ];
        var img = null;
        for (var i = 0; i < imgSels.length; i++) {
          var el = document.querySelector(imgSels[i]);
          if (el && el.complete && el.naturalWidth > 0) { img = el; break; }
        }
        var txtSels = [
          '.rc-imageselect-instructions-hidden',
          '.rc-imageselect-instructions',
          '.rc-imageselect-desc-wrapper',
          '.rc-imageselect-desc',
          '.rc-imageselect-desc-no-canonical',
        ];
        var txt = '';
        for (var j = 0; j < txtSels.length; j++) {
          var el2 = document.querySelector(txtSels[j]);
          if (el2) { var t = (el2.innerText || '').trim(); if (t.length > 5) { txt = t; break; } }
        }
        if (!img || !txt) return null;
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        if (ctx) { ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high'; ctx.drawImage(img,0,0); }
        var cols=3, rows=3;
        var cs=['.rc-imageselect-table-33 td','.rc-imageselect-table-44 td','.rc-imageselect-table td','.rc-imageselect-tile'];
        for (var k=0;k<cs.length;k++){
          var cells=document.querySelectorAll(cs[k]);
          if(cells.length===9){cols=rows=3;break;}
          if(cells.length===16){cols=rows=4;break;}
        }
        return { body: canvas.toDataURL('image/png').split(',')[1], comment: txt, columns: cols, rows: rows };
      };
    })()`);
  }

  private async getParams(bframe: Frame): Promise<{ body: string; comment: string; columns: number; rows: number } | null> {
    try {
      return await bframe.evaluate(
        `(function(){ return window.getCaptchaParams ? window.getCaptchaParams() : null; })()`
      ) as { body: string; comment: string; columns: number; rows: number } | null;
    } catch {
      return null;
    }
  }

  // ── Tile clicking ───────────────────────────────────────────────────────────

  private parseClicks(data: string): number[] {
    return data.replace("click:", "").split("/").map(Number);
  }

  private async clickTile(bframe: Frame, position: number, cols: number, rows: number): Promise<void> {
    const row = Math.floor((position - 1) / cols);
    const col = (position - 1) % cols;
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;

    for (const tableSel of [".rc-imageselect-table-33", ".rc-imageselect-table-44", ".rc-imageselect-table"]) {
      try {
        const table = bframe.locator(tableSel);
        if ((await table.count()) === 0) continue;
        const cell = table.first().locator("tr").nth(row).locator("td").nth(col);
        if ((await cell.count()) > 0) {
          await this.wait(80);
          await cell.click({ delay: 60 });
          console.log(`[captcha] Clicked pos ${position} (row ${row + 1}, col ${col + 1})`);
          break;
        }
      } catch (err) {
        console.warn(`[captcha] Tile click error at ${position}:`, (err as Error).message);
      }
    }
    await this.wait(200);
  }

  private async clickVerify(bframe: Frame): Promise<void> {
    try {
      const btn = bframe.locator("#recaptcha-verify-button");
      if ((await btn.count()) > 0) {
        await btn.click({ delay: 80 });
        console.log("[captcha] Clicked Verify");
      }
    } catch (err) {
      console.warn("[captcha] Verify click failed:", (err as Error).message);
    }
  }

  private async clickSkip(bframe: Frame): Promise<void> {
    try {
      const byId = bframe.locator("#recaptcha-skip-button");
      if ((await byId.count()) > 0) { await byId.click({ delay: 80 }); return; }
      const byText = bframe.getByText("Skip", { exact: true });
      if ((await byText.count()) > 0) { await byText.first().click({ delay: 80 }); return; }
    } catch { /* ignore */ }
    await this.clickVerify(bframe);
  }

  // ── Main grid loop ──────────────────────────────────────────────────────────

  private async solveGrid(page: Page, siteKey?: string): Promise<boolean> {
    const solver = this.solver!;

    let bframe = await waitForBframe(page, 10_000, siteKey);
    if (!bframe) { console.warn("[captcha] bframe not found"); return false; }

    await this.wait(2_000);
    await this.injectParamsExtractor(bframe);

    const MAX_ROUNDS = 8;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      console.log(`[captcha] Grid round ${round}/${MAX_ROUNDS}`);

      // Refresh bframe each round (it re-attaches when new images load)
      const freshBframe = await waitForBframe(page, 5_000, siteKey);
      if (!freshBframe) {
        return await isRecaptchaPassed(page, siteKey);
      }
      bframe = freshBframe;
      // Re-inject each round — bframe may have reloaded with a new JS context
      await this.injectParamsExtractor(bframe).catch(() => {});

      if (await this.isChallengeExpired(page)) {
        console.warn("[captcha] Challenge expired — re-clicking checkbox");
        const anchor = await waitForAnchorFrame(page, 5_000, siteKey);
        if (anchor) await this.clickCheckboxInFrame(anchor);
        if (await this.waitForPassed(page, 15_000, siteKey)) return true;
        bframe = await waitForBframe(page, 5_000, siteKey) ?? bframe;
        await this.injectParamsExtractor(bframe);
        continue;
      }

      const params = await this.getParams(bframe);
      if (!params || !params.body || params.body.length < 1_000 || !params.comment || params.comment.length < 5) {
        await this.wait(500);
        await this.clickVerify(bframe);
        if (await this.waitForPassed(page, 15_000, siteKey)) return true;
        continue;
      }

      console.log(`[captcha] ${params.columns}x${params.rows} — "${params.comment}"`);

      if (await this.isChallengeExpired(page)) {
        const anchor = await waitForAnchorFrame(page, 5_000, siteKey);
        if (anchor) await this.clickCheckboxInFrame(anchor);
        if (await this.waitForPassed(page, 15_000, siteKey)) return true;
        continue;
      }

      console.log("[captcha] Sending to 2captcha…");
      const answer = await solver.grid({
        recaptcha: 1, body: params.body, textinstructions: params.comment,
        cols: params.columns, rows: params.rows, canSkip: 1, lang: "en",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = answer?.data ?? (answer as any)?.solution?.click;
      const dataStr = Array.isArray(raw) ? `click:${raw.join("/")}` : String(raw ?? "");
      console.log(`[captcha] 2captcha answer: ${dataStr}`);

      if (dataStr === "No_matching_images" || raw === "No_matching_images") {
        await this.wait(800);
        await this.clickSkip(bframe);
        if (await this.waitForPassed(page, 15_000, siteKey)) { console.log("[captcha] ✅ Solved (skip)"); return true; }
        continue;
      }
      if (dataStr.includes("ERROR_CAPTCHA_UNSOLVABLE")) {
        await this.clickVerify(bframe);
        if (await this.waitForPassed(page, 15_000, siteKey)) return true;
        continue;
      }

      const clicks = Array.isArray(raw) ? raw.map(Number) : this.parseClicks(dataStr);
      if (!dataStr.startsWith("click:") && !Array.isArray(raw)) {
        console.error(`[captcha] Unexpected format: ${dataStr}`);
        continue;
      }

      const maxPos = params.columns * params.rows;
      const valid  = clicks.filter((c) => c >= 1 && c <= maxPos);

      console.log(`[captcha] Clicking tiles: [${valid.join(", ")}]`);
      for (let i = 0; i < valid.length; i++) {
        await this.wait(100 * i);
        await this.clickTile(bframe, valid[i], params.columns, params.rows);
      }

      await this.wait(2_000);
      await this.clickVerify(bframe);
      if (await this.waitForPassed(page, 15_000, siteKey)) {
        console.log("[captcha] ✅ Grid captcha solved!");
        return true;
      }
    }

    await this.clickVerify(bframe);
    return this.waitForPassed(page, 15_000, siteKey);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // hCaptcha — token injection
  // ═══════════════════════════════════════════════════════════════════════════

  async solveHCaptcha(options: { siteKey: string; pageUrl: string }): Promise<string> {
    if (this.solver) {
      try {
        const r = await this.solver.hcaptcha({ sitekey: options.siteKey, pageurl: options.pageUrl });
        return r.data as string;
      } catch (err) { console.warn("[captcha] 2captcha hCaptcha:", (err as Error).message); }
    }
    if (capsolverApiKey) {
      const id = await capsolverCreateTask(capsolverApiKey, {
        type: "HCaptchaTask", websiteURL: options.pageUrl, websiteKey: options.siteKey,
      });
      return capsolverGetResult(capsolverApiKey, id);
    }
    throw new Error("[captcha] No solver configured");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Arkose / FunCaptcha — token injection
  // ═══════════════════════════════════════════════════════════════════════════

  async solveArkose(options: { publicKey: string; pageUrl: string; blob?: string }): Promise<string> {
    if (this.solver) {
      try {
        const r = await this.solver.funCaptcha({
          publickey: options.publicKey, pageurl: options.pageUrl,
          ...(options.blob ? { data: JSON.stringify({ blob: options.blob }) } : {}),
        });
        return r.data as string;
      } catch (err) { console.warn("[captcha] 2captcha Arkose:", (err as Error).message); }
    }
    if (capsolverApiKey) {
      const id = await capsolverCreateTask(capsolverApiKey, {
        type: "FunCaptchaTask", websiteURL: options.pageUrl,
        websitePublicKey: options.publicKey,
        funcaptchaApiJSSubdomain: "linkedin-api.arkoselabs.com",
        data: options.blob ? JSON.stringify({ blob: options.blob }) : undefined,
      });
      return capsolverGetResult(capsolverApiKey, id);
    }
    throw new Error("[captcha] No solver configured");
  }
}

let _service: CaptchaService | null = null;

export function getCaptchaService(opts?: CaptchaServiceOptions): CaptchaService {
  if (!_service) {
    if (!opts) throw new Error("[captcha] Service not initialised");
    _service = new CaptchaService(opts);
  }
  return _service;
}
