## Requirements

- **Node.js** 18 or newer
- **Chromium** (installed via Playwright)
- **2captcha API key** — required when the site shows a CAPTCHA challenge

## Setup

```bash
cd folder
npm install
npm run playwright:install
```

### 2. Configure environment variables

Copy the example env file and add your 2captcha API key:

```bash
cp .env.example .env
```

Edit `.env`:

```env
TWOCAPTCHA_API_KEY=your_2captcha_api_key_here
```

Get a key at [2captcha.com/enterpage](https://2captcha.com/enterpage).

## Start

```bash
npm start
```
