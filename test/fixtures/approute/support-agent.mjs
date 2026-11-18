// The worked example in docs/app-through-proxy.md: one app, four APIs, each routed.
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { WebClient } from '@slack/web-api';

// Anthropic: the SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from the environment
const anthropic = new Anthropic();

// Stripe: its SDK takes a host but not a path, so hand it a fetch that swaps the origin
const base = process.env.STRIPE_API_BASE;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, base
  ? { httpClient: Stripe.createFetchHttpClient((url, init) => fetch(String(url).replace('https://api.stripe.com', base), init)) }
  : {});

// Slack: the base URL is the slackApiUrl option; unset, the client uses https://slack.com/api/
const slack = new WebClient(process.env.SLACK_BOT_TOKEN, { slackApiUrl: process.env.SLACK_API_URL });

// Zendesk: basic auth, "{email}/token" as the user name and the API token as the password
const zendesk = process.env.ZENDESK_API_URL ?? 'https://yourcompany.zendesk.com';
const zendeskAuth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');

const tickets = await (await fetch(`${zendesk}/api/v2/tickets.json`, { headers: { Authorization: `Basic ${zendeskAuth}` } })).json();
const customers = await stripe.customers.list({ limit: 3 });        // allowed: a GET
const reply = await anthropic.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: `Draft a reply to ticket ${tickets.tickets[0].id} for ${customers.data.length} customers.` }],
});
const posted = await slack.chat.postMessage({ channel: 'C0SUPPORT', text: reply.content[0].text });

let refund;
try {
  await stripe.refunds.create({ charge: 'ch_1' }, { maxNetworkRetries: 0 });
  refund = 'sent';
} catch (err) {
  refund = `refused with ${err.statusCode}`;                         // 403 from the proxy; Stripe never sees it
}

console.log(JSON.stringify({ ticket: tickets.tickets[0].id, customers: customers.data.length, reply: reply.content[0].text, posted: posted.ts, refund, env: process.env }));
