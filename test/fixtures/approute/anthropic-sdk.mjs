// Anthropic SDK for JavaScript. Reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment.
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();
const message = await anthropic.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Summarize ticket 42 in one sentence.' }],
});
console.log(JSON.stringify({ result: message.content[0].text, env: process.env }));
