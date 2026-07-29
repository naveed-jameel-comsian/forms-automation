const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('./config');

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

const NOT_A_QUESTION = 'NOT_A_QUESTION';

// Step 4 — ask Claude whether the text near a field is a question, and if so, the answer.
async function answerSecurityField({ text, title, content }) {
    const prompt = `You are helping to register on a forum.
Look at this text found near a form field and determine if it is a security question or instruction that requires an answer.
If yes, provide the exact answer to fill in the field.
If no, reply with "${NOT_A_QUESTION}".

Text found : ${text}
Page title : ${title}
Page content (first 500 chars) : ${content}

Reply ONLY with the answer to fill in, nothing else.`;

    const response = await anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
    });

    const answer = (response.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

    if (!answer || answer.toUpperCase().includes(NOT_A_QUESTION)) {
        return null;
    }
    return answer;
}

// Ask Claude for a password that satisfies the forum's detected rules.
async function generatePasswordFromRules(detectedRules) {
    const prompt = `Generate a valid password for a forum with these rules : ${detectedRules}
The password must also be minimum 12 characters, contain uppercase, lowercase, number and special character.
Reply ONLY with the password, nothing else.`;

    const response = await anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
    });

    const password = (response.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
        // Strip accidental quotes/backticks Claude sometimes wraps around the answer.
        .replace(/^["'`]+|["'`]+$/g, '')
        .split(/\s+/)[0];

    if (!password || password.length < 8) {
        throw new Error('Claude did not return a usable password');
    }
    return password;
}

module.exports = { answerSecurityField, generatePasswordFromRules, NOT_A_QUESTION };
