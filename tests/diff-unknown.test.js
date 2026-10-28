'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQuote, diffQuotes, mergeInputs } = require('../src/quote');
const { DealService } = require('../src/deals');
const { MockPayPal } = require('../src/paypal');
const { parseWithRegex } = require('../src/agent');

const BASE = {
  product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: 8.5,
  originPort: 'Busan', destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft',
};
const FULL = mergeInputs(BASE, { inlandHaulage: 300 });

test('CIF -> DAP diff: insurance becomes optional and drops out of the invoice, duty/VAT recomputed', () => {
  const cif = buildQuote(FULL, 'CIF');
  const dap = buildQuote(FULL, 'DAP');
  const d = diffQuotes(cif, dap);
  assert.equal(d.incotermFrom, 'CIF');
  assert.equal(d.incotermTo, 'DAP');
  const keys = d.changes.map((c) => c.key).sort();
  assert.deepEqual(keys, ['importDuty', 'importVat', 'insurance']);
  const ins = d.changes.find((c) => c.key === 'insurance');
  assert.equal(ins.optionalFrom, false);
  assert.equal(ins.optionalTo, true);
  assert.equal(ins.invoiceDelta, -cif.lines.find((l) => l.key === 'insurance').amount);
  // payer of duty/VAT stays "buyer" but the amount changes because customs value loses the insurance cost
  const duty = d.changes.find((c) => c.key === 'importDuty');
  assert.equal(duty.payerFrom, 'buyer');
  assert.equal(duty.payerTo, 'buyer');
  assert.ok(duty.amountTo < duty.amountFrom);
  assert.equal(d.invoiceDelta, Math.round((dap.invoice.total - cif.invoice.total) * 100) / 100);
  assert.ok(d.invoiceDelta < 0);
  assert.ok(d.terms.to.delivery.includes('destination'));
});

test('CIF -> FOB diff: freight and insurance move to the buyer', () => {
  const cif = buildQuote(FULL, 'CIF');
  const fob = buildQuote(FULL, 'FOB');
  const d = diffQuotes(cif, fob);
  const fr = d.changes.find((c) => c.key === 'oceanFreight');
  assert.equal(fr.payerFrom, 'seller');
  assert.equal(fr.payerTo, 'buyer');
  assert.equal(fr.invoiceDelta, -2850);
  assert.equal(d.invoiceTo, Math.round((cif.invoice.total - 2850 - cif.lines.find((l) => l.key === 'insurance').amount) * 100) / 100);
});

test('CIF -> DDP diff adds duty and VAT to the invoice', () => {
  const d = diffQuotes(buildQuote(FULL, 'CIF'), buildQuote(FULL, 'DDP'));
  for (const k of ['importDuty', 'importVat']) {
    const c = d.changes.find((x) => x.key === k);
    assert.equal(c.payerFrom, 'buyer');
    assert.equal(c.payerTo, 'seller');
    assert.ok(c.invoiceDelta > 0);
  }
});

test('unknown values stay unknown: no price, no origin, no inland haulage', () => {
  const t = 'Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container.';
  const q = buildQuote(mergeInputs(parseWithRegex(t), {}), 'CIF');
  const byKey = Object.fromEntries(q.lines.map((l) => [l.key, l]));
  for (const k of ['goods', 'exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance', 'destTHC', 'importDuty', 'importVat']) {
    assert.equal(byKey[k].amount, null, `${k} must be null`);
    assert.equal(byKey[k].state, 'unknown', `${k} must be flagged unknown`);
  }
  assert.equal(q.invoice.issuable, false);
  assert.equal(q.invoice.total, null);
  assert.equal(q.totals.landedTotal, null);
  const needKeys = q.missingInputs.map((m) => m.key);
  assert.ok(needKeys.includes('unitPrice'));
  assert.ok(needKeys.includes('originPort'));
  assert.ok(needKeys.includes('inlandHaulage'));
});

test('unknown never becomes zero: lane gaps in the sample table stay unknown (Incheon -> Hamburg)', () => {
  const inp = mergeInputs({ ...BASE, originPort: 'Incheon', destPort: 'Hamburg', hsCode: '8504.40' }, { inlandHaulage: 100 });
  const q = buildQuote(inp, 'CIF');
  const ec = q.lines.find((l) => l.key === 'exportClearance');
  assert.equal(ec.amount, null);
  assert.ok(q.invoice.missing.includes('exportClearance'));
  assert.equal(q.lines.find((l) => l.key === 'importDuty').amount, null);
  // supplying the value resolves it and cascades
  const q2 = buildQuote(mergeInputs(inp, { inlandHaulage: 100, exportClearance: 55 }), 'CIF');
  assert.equal(q2.lines.find((l) => l.key === 'exportClearance').amount, 55);
  assert.equal(q2.lines.find((l) => l.key === 'exportClearance').source, 'user input');
  assert.ok(q2.invoice.issuable);
});

test('HS code without a rate for the region is unknown, not 0%', () => {
  const inp = mergeInputs({ ...BASE, hsCode: '3926.90' }, { inlandHaulage: 300 });
  const q = buildQuote(inp, 'CIF');
  assert.equal(q.lines.find((l) => l.key === 'importDuty').amount, null);
  assert.ok(q.missingInputs.some((m) => m.key === 'dutyRatePct'));
  const q2 = buildQuote(mergeInputs(inp, { dutyRatePct: 5 }), 'CIF');
  assert.ok(q2.lines.find((l) => l.key === 'importDuty').amount > 0);
});

test('unknown buyer-side lines do not block the seller invoice', () => {
  const inp = mergeInputs({ ...BASE, hsCode: '3926.90' }, { inlandHaulage: 300 });
  const q = buildQuote(inp, 'CIF');
  assert.equal(q.invoice.issuable, true);
  assert.equal(q.totals.buyerComplete, false);
});

test('full flow in MOCK mode: issue v1, switch CIF -> DAP, v1 cancelled, v2 issued with a diff, then paid', async () => {
  const svc = new DealService({ paypal: new MockPayPal(), env: {} });
  const text = 'Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters at USD 8.50 each, shipping from Busan, CIF Rotterdam, 40ft container.';
  const deal = await svc.create(text);
  assert.equal(deal.incoterm, 'CIF');
  await assert.rejects(() => svc.issue(deal.id), (e) => e.status === 422 && e.missing.includes('inlandHaulage'));
  svc.setWorking(deal.id, { overrides: { inlandHaulage: 300 } });
  const v1 = await svc.issue(deal.id);
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'SENT');
  const v2 = await svc.reissue(deal.id, { incoterm: 'DAP' });
  assert.equal(v2.version, 2);
  assert.equal(v2.incoterm, 'DAP');
  assert.equal(deal.invoices[0].status, 'CANCELLED');
  assert.equal(v2.diffFromPrevious.incotermFrom, 'CIF');
  assert.equal(v2.diffFromPrevious.incotermTo, 'DAP');
  assert.ok(v2.diffFromPrevious.invoiceDelta < 0);
  assert.equal((await svc.paypal.get(v1.paypalId)).status, 'CANCELLED');
  assert.equal((await svc.paypal.get(v2.paypalId)).status, 'SENT');
  const paid = await svc.mockPay(deal.id);
  assert.equal(paid.status, 'PAID');
  await assert.rejects(() => svc.reissue(deal.id, { incoterm: 'FOB' }), (e) => e.status === 409);
  assert.ok(deal.timeline.some((e) => e.type === 'invoice_cancelled'));
});

test('failed re-issue (unknown seller lines) leaves v1 active and untouched', async () => {
  const svc = new DealService({ paypal: new MockPayPal(), env: {} });
  const deal = await svc.create('Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters at USD 8.50 each, shipping from Busan, FOB Busan, 40ft container.');
  svc.setWorking(deal.id, { overrides: { inlandHaulage: 300 } });
  await svc.issue(deal.id);
  // DAP needs destination figures that exist, so force a gap with a lane the table lacks
  deal.parsed.destPort = 'Hamburg'; deal.parsed.originPort = 'Incheon';
  await assert.rejects(() => svc.reissue(deal.id, { incoterm: 'CIF' }), (e) => e.status === 422);
  assert.equal(deal.invoices.length, 1);
  assert.equal(deal.invoices[0].status, 'SENT');
  assert.equal(deal.incoterm, 'FOB');
});
