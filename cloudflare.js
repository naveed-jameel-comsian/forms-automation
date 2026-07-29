const API_KEY = "223c4812acb9c5efe3566dfb2f913bc3"

/**
 * Inject Turnstile interceptor BEFORE page load
 */
export async function injectTurnstileInterceptor(page) {
  await page.addInitScript(() => {
    const i = setInterval(() => {
      if (window.turnstile) {
        clearInterval(i)

        window.turnstile.render = (a, b) => {
          window.cfParams = {
            sitekey: b.sitekey,
            action: b.action,
            cData: b.cData,
            chlPageData: b.chlPageData,
            userAgent: navigator.userAgent
          }

          window.tsCallback = b.callback

          return 'foo'
        }
      }
    }, 10)
  })
}

/**
 * Wait and extract Turnstile params
 */
async function getTurnstileParams(page) {
  return await page.waitForFunction(() => window.cfParams, { timeout: 20000 })
    .then(res => res.jsonValue())
}

/**
 * Send captcha to 2Captcha
 */
async function solveCaptcha(params, page) {
  const request = {
    method: "turnstile",
    key: API_KEY,
    sitekey: params.sitekey,
    pageurl: page.url(),
    data: params.cData,
    pagedata: params.chlPageData,
    action: params.action,
    userAgent: params.userAgent,
    json: 1
  }

  const res = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    body: new URLSearchParams(request)
  })

  const data = await res.json()

  if (data.status !== 1) {
    throw new Error("2Captcha submit failed: " + JSON.stringify(data))
  }

  const requestId = data.request

  // Poll for result
  while (true) {
    await new Promise(r => setTimeout(r, 5000))

    const result = await fetch(
      `https://2captcha.com/res.php?key=${API_KEY}&action=get&id=${requestId}&json=1`
    ).then(r => r.json())

    if (result.status === 1) {
      return result.request
    }

    if (result.request !== "CAPCHA_NOT_READY") {
      throw new Error("2Captcha error: " + result.request)
    }
  }
}

/**
 * Apply captcha solution via callback
 */
async function applyCaptchaSolution(page, token) {
  await page.evaluate((token) => {
    if (window.tsCallback) {
      window.tsCallback(token)
    }
  }, token)
}

/**
 * Handle Cloudflare challenge
 */
export async function handleCloudflare(page) {
  const title = await page.title()
  if (title.includes('Just a moment') || title.includes('Verification')) {
    console.log("⚠️ Cloudflare challenge detected")

    const params = await getTurnstileParams(page)
    console.log("✅ Extracted params")

    const token = await solveCaptcha(params, page)
    console.log("✅ Captcha solved")

    await applyCaptchaSolution(page, token)

    await page.waitForNavigation({ timeout: 60000 })
    console.log("✅ Challenge passed")
  }
}