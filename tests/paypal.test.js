'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SandboxPayPal, MockPayPal, createClient, buildInvoicePayload, SANDBOX_BASE } = require('../src/paypal');
const { buildQuote, mergeInputs } = require('../src/quote');

const inputs = mergeInputs({
  product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: 8.5,
  originPort: 'Busan', destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft',
}, { inlandHaulage: 300 });

test('createClient: MOCK without keys, sandbox with keys', () => {
  assert.equal(createClient({}).mode, 'mock');
  assert.equal(createClient({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).mode, 'sandbox');
});

test('invoice payload follows the Invoicing v2 shape and totals match the quote', () => {
  const q = buildQuote(inputs, 'CIF');
  const p = buildInvoicePayload({ dealId: 'deal-x', version: 1, quote: q, inputs, env: {} });
  assert.equal(p.detail.currency_code, 'USD');
  assert.equal(p.detail.reference, 'deal-x-v1');
  assert.ok(p.detail.invoice_number === undefined, 'invoice_number omitted so PayPal auto-increments');
  assert.ok(Array.isArray(p.primary_recipients) && p.primary_recipients[0].billing_info.email_address);
  const total = p.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_amount.value), 0);
  assert.ok(Math.abs(total - q.invoice.total) < 0.011);
  for (const i of p.items) {
    assert.equal(typeof i.quantity, 'string');
    assert.match(i.unit_amount.value, /^\d+\.\d{2}$/);
  }
  assert.equal(p.items[0].quantity, '2400');
});

test('sandbox client: OAuth client-credentials, create, send, cancel, get (injected fetch)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.endsWith('/v2/invoicing/invoices') && init.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'INV2-TEST', detail: { invoice_number: '0001' } }) };
    if (url.endsWith('/send')) return { ok: true, status: 200, json: async () => ({ rel: 'self' }) };
    if (url.endsWith('/cancel')) return { ok: true, status: 204 };
    return { ok: true, status: 200, json: async () => ({ id: 'INV2-TEST', status: 'SENT' }) };
  };
  const c = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const d = await c.createDraft({ detail: {}, items: [] });
  await c.send(d.id);
  await c.cancel(d.id, { note: 'x' });
  assert.equal((await c.get(d.id)).status, 'SENT');
  assert.equal(calls[0].url, `${SANDBOX_BASE}/v1/oauth2/token`);
  assert.equal(calls[0].body, 'grant_type=client_credentials');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
  assert.equal(calls.filter((x) => x.url.endsWith('/v1/oauth2/token')).length, 1, 'token is cached');
  assert.ok(calls.some((x) => x.url.endsWith('/v2/invoicing/invoices/INV2-TEST/send')));
  assert.ok(calls.some((x) => x.url.endsWith('/v2/invoicing/invoices/INV2-TEST/cancel')));
});

test('mock client enforces the same lifecycle rules (draft cannot be cancelled)', async () => {
  const m = new MockPayPal();
  const d = await m.createDraft({ detail: { currency_code: 'USD' }, items: [{ quantity: '1', unit_amount: { value: '10.00' } }] });
  await assert.rejects(() => m.cancel(d.id), (e) => e.status === 422);
  await m.send(d.id);
  assert.equal((await m.get(d.id)).status, 'SENT');
  await m.cancel(d.id);
  assert.equal((await m.get(d.id)).status, 'CANCELLED');
});
