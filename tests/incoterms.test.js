'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CODES, LINE_KEYS, allocationFor, ALLOCATION } = require('../src/incoterms');
const { buildQuote, mergeInputs } = require('../src/quote');

const FULL = mergeInputs({
  product: 'power adapters', hsCode: '8504.40', quantity: 2400, unitPrice: 8.5,
  originPort: 'Busan', destPort: 'Rotterdam', incoterm: 'CIF', containerType: '40ft',
}, { inlandHaulage: 300 });

// Expected seller-borne cost lines per rule, from ICC Incoterms 2020 (A9/B9), see src/incoterms.js.
const EXPECTED_SELLER = {
  EXW: [],
  FCA: ['exportClearance', 'inlandHaulage'],
  FAS: ['exportClearance', 'inlandHaulage'],
  FOB: ['exportClearance', 'inlandHaulage', 'originTHC'],
  CPT: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight'],
  CFR: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight'],
  CIP: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance'],
  CIF: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance'],
  DAP: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance'],
  DPU: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance', 'destTHC'],
  DDP: ['exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance', 'importDuty', 'importVat'],
};

test('all 11 Incoterms 2020 rules exist and cover every cost line', () => {
  assert.equal(CODES.length, 11);
  assert.deepEqual([...CODES].sort(), Object.keys(EXPECTED_SELLER).sort());
  for (const c of CODES) {
    for (const k of LINE_KEYS) assert.ok(['seller', 'buyer'].includes(ALLOCATION[c][k]), `${c}.${k}`);
  }
});

for (const code of Object.keys(EXPECTED_SELLER)) {
  test(`allocation matches ICC matrix for ${code}`, () => {
    const payers = allocationFor(code).payers;
    const seller = LINE_KEYS.filter((k) => payers[k] === 'seller');
    // insurance under DAP/DPU/DDP is a seller line too (risk-bearing) but optional, so compare payer only
    assert.deepEqual(seller.sort(), [...EXPECTED_SELLER[code]].sort());
  });

  test(`quote under ${code}: coloured lines and invoice agree with the matrix`, () => {
    const q = buildQuote(FULL, code);
    const sellerLines = q.lines.filter((l) => l.payer === 'seller' && !l.optional && l.key !== 'goods').map((l) => l.key);
    const expected = EXPECTED_SELLER[code].filter((k) => !(k === 'insurance' && !['CIF', 'CIP'].includes(code)));
    assert.deepEqual(sellerLines.sort(), [...expected].sort());
    assert.ok(q.invoice.issuable, `${code} invoice should be issuable with full inputs`);
    const invoiceKeys = q.invoice.lines.map((l) => l.key).filter((k) => k !== 'goods');
    assert.deepEqual(invoiceKeys.sort(), [...expected].sort());
    const sum = q.invoice.lines.reduce((s, l) => s + l.amount, 0);
    assert.ok(Math.abs(sum - q.invoice.total) < 0.011);
    assert.equal(q.invoice.lines[0].key, 'goods');
  });
}

test('insurance is mandatory only under CIF/CIP and optional elsewhere', () => {
  for (const c of CODES) {
    const q = buildQuote(FULL, c);
    const ins = q.lines.find((l) => l.key === 'insurance');
    assert.equal(ins.optional, !['CIF', 'CIP'].includes(c), c);
  }
});

test('DDP moves duty and VAT onto the seller invoice; CIF leaves them with the buyer', () => {
  const ddp = buildQuote(FULL, 'DDP');
  const cif = buildQuote(FULL, 'CIF');
  assert.ok(ddp.invoice.lines.some((l) => l.key === 'importDuty'));
  assert.ok(ddp.invoice.lines.some((l) => l.key === 'importVat'));
  assert.ok(!cif.invoice.lines.some((l) => l.key === 'importDuty'));
  assert.ok(ddp.invoice.total > cif.invoice.total);
});

test('arithmetic: CIF Busan->Rotterdam sample figures', () => {
  const q = buildQuote(FULL, 'CIF');
  const L = Object.fromEntries(q.lines.map((l) => [l.key, l.amount]));
  assert.equal(L.goods, 20400);
  assert.equal(L.exportClearance, 40);
  assert.equal(L.originTHC, 190);
  assert.equal(L.oceanFreight, 2850);
  assert.equal(L.inlandHaulage, 300);
  // CFR = 23,780; premium = k*CFR/(1-k), k = 1.1*0.2% = 0.0022
  assert.equal(L.insurance, Math.round(((0.0022 * 23780) / (1 - 0.0022)) * 100) / 100);
  const cif = 23780 + L.insurance;
  assert.equal(q.customsValue, Math.round(cif * 100) / 100);
  assert.equal(L.importDuty, Math.round(cif * 0.033 * 100) / 100);
});
