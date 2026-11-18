// @slack/web-api. The base URL is the slackApiUrl option; the client appends the method name to it.
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN, { slackApiUrl: process.env.SLACK_API_URL });
const posted = await slack.chat.postMessage({ channel: 'C0SUPPORT', text: 'Ticket 42 answered.' });
console.log(JSON.stringify({ result: posted.ts, env: process.env }));
