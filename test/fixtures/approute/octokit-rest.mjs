// @octokit/rest. The base URL is the baseUrl option.
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com' });
const { data } = await octokit.rest.users.getAuthenticated();
console.log(JSON.stringify({ result: data.login, env: process.env }));
