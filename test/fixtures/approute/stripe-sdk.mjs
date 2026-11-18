// Stripe SDK for JavaScript. It takes a host but not a path, so it is handed a fetch that swaps the origin.
// Argument: "refund" tries a write; anything else lists customers.
import Stripe from 'stripe';

const base = process.env.STRIPE_API_BASE;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, base
  ? { httpClient: Stripe.createFetchHttpClient((url, init) => fetch(String(url).replace('https://api.stripe.com', base), init)) }
  : {});

try {
  if (process.argv[2] === 'refund') {
    const refund = await stripe.refunds.create({ charge: 'ch_1' }, { maxNetworkRetries: 0 });
    console.log(JSON.stringify({ result: refund.id, env: process.env }));
  } else {
    const customers = await stripe.customers.list({ limit: 3 });
    console.log(JSON.stringify({ result: customers.data.map((c) => c.id), env: process.env }));
  }
} catch (err) {
  console.log(JSON.stringify({ error: { status: err.statusCode ?? null, message: String(err.message) }, env: process.env }));
}
