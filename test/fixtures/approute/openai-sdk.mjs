// OpenAI SDK for JavaScript. Reads OPENAI_API_KEY and OPENAI_BASE_URL from the environment.
import OpenAI from 'openai';

const openai = new OpenAI();
const completion = await openai.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Say routed.' }],
});
console.log(JSON.stringify({ result: completion.choices[0].message.content, env: process.env }));
