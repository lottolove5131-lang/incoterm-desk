'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWithRegex, sanitize, parseRequest } = require('../src/agent');

test('regex parser: the reference request (no price, no origin)', () => {
  const f = parseWithRegex('Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container.');
  assert.deepEqual(f, {
    product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: null,
    originPort: null, destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft',
  });
});

test('regex parser: price per unit, origin and destination', () => {
  const f = parseWithRegex('Need 500 pcs of HS 610910 cotton t-shirts at $4.20 each from Busan to Los Angeles, FOB Busan, 20ft');
  assert.equal(f.quantity, 500);
  assert.equal(f.hsCode, '6109.10');
  assert.equal(f.unitPrice, 4.2);
  assert.equal(f.originPort, 'Busan');
  assert.equal(f.destPort, 'Los Angeles');
  assert.equal(f.incoterm, 'FOB');
  assert.equal(f.containerType, '20ft');
});

test('regex parser: high cube, lowercase incoterm', () => {
  const f = parseWithRegex('1,000 units of HS 9503.00 toys, dap hamburg, 40ft HC container, USD 3/unit');
  assert.equal(f.containerType, '40hc');
  assert.equal(f.incoterm, 'DAP');
  assert.equal(f.unitPrice, 3);
  assert.equal(f.destPort, 'Hamburg');
});

test('regex parser never invents numbers when none are given', () => {
  const f = parseWithRegex('Please quote power adapters to Rotterdam');
  assert.equal(f.quantity, null);
  assert.equal(f.unitPrice, null);
  assert.equal(f.hsCode, null);
  assert.equal(f.incoterm, null);
  assert.equal(f.containerType, null);
});

test('a bare total price is not mistaken for a unit price', () => {
  const f = parseWithRegex('2,400 units of HS 8504.40 adapters, budget USD 20,000 total, CIF Rotterdam');
  assert.equal(f.unitPrice, null);
});

test('sanitize drops numbers and codes the model made up', () => {
  const text = 'Buyer wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container.';
  const { fields, warnings } = sanitize(text, {
    product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: 9.99,
    originPort: 'Busan', destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft',
  });
  assert.equal(fields.quantity, 2400);
  assert.equal(fields.unitPrice, null);
  assert.equal(fields.originPort, null);
  assert.equal(fields.destPort, 'Rotterdam');
  assert.ok(warnings.some((w) => w.includes('9.99')));
  assert.ok(warnings.some((w) => w.includes('Busan')));
});

test('sanitize drops an Incoterm or HS code that is not in the text', () => {
  const { fields, warnings } = sanitize('Quote 100 units of widgets to Hamburg', { incoterm: 'DDP', hsCode: '8504.40', quantity: 100 });
  assert.equal(fields.incoterm, null);
  assert.equal(fields.hsCode, null);
  assert.equal(fields.quantity, 100);
  assert.equal(warnings.length, 2);
});

test('Gemini adapter: model output is verified; hallucinated price is rejected (injected fetch, no network)', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: 12.5,
        originPort: null, destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft' }) }] } }] }),
    };
  };
  const text = 'Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container.';
  const r = await parseRequest(text, { apiKey: 'test-key-not-real', fetchImpl });
  assert.match(r.source, /^gemini:gemini-flash-lite-latest$/);
  assert.ok(seen.url.includes('gemini-flash-lite-latest:generateContent'));
  assert.equal(seen.init.headers['x-goog-api-key'], 'test-key-not-real');
  assert.equal(r.fields.unitPrice, null);
  assert.equal(r.fields.quantity, 2400);
  assert.ok(r.warnings.some((w) => w.includes('12.5')));
});

test('Gemini failure falls back to regex without throwing, and the error does not leak the key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const r = await parseRequest('500 units of HS 8504.40 adapters, CIF Rotterdam', { apiKey: 'secret-key-xyz', fetchImpl });
  assert.equal(r.source, 'regex');
  assert.equal(r.fields.quantity, 500);
  assert.ok(!JSON.stringify(r).includes('secret-key-xyz'));
});

test('no API key -> regex source', async () => {
  const r = await parseRequest('500 units of HS 8504.40 adapters, CIF Rotterdam', { apiKey: '' });
  assert.equal(r.source, 'regex');
});
