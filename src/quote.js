'use strict';
/*
 * Landed-cost quote builder.
 *
 * Rule #1: never invent a number. Every amount is either
 *   - taken from the request / user overrides,
 *   - taken from the clearly labelled sample tables in rates.js, or
 *   - derived arithmetically from known amounts.
 * Otherwise it is null and the line is marked state "unknown" ("unknown - needs input").
 *
 * Simplifications (documented, demo only):
 *   - EU customs value = CIF value (price + all costs to destination port; insurance only if the
 *     seller must buy it). US customs value = FOB-type value (price + costs up to loading).
 *   - Import VAT base = customs value + duty (EU). Insurance premium = 110% x CIF value x rate,
 *     solved without circularity: premium = f*r*CFR / (1 - f*r).
 */

const { allocationFor, LINE_KEYS } = require('./incoterms');
const R = require('./rates');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sumOrNull = (arr) => (arr.every(isNum) ? round2(arr.reduce((a, b) => a + b, 0)) : null);

const LABELS = {
  goods: 'Goods value (EXW price)',
  exportClearance: 'Export clearance',
  inlandHaulage: 'Inland haulage',
  originTHC: 'Origin THC',
  oceanFreight: 'Ocean freight',
  insurance: 'Insurance',
  destTHC: 'Destination THC',
  importDuty: 'Import duty',
  importVat: 'VAT / import taxes',
};

const INPUT_LABELS = {
  quantity: 'Quantity (units)',
  unitPrice: 'Unit price (USD, EXW)',
  hsCode: 'HS code',
  originPort: 'Origin port',
  destPort: 'Destination port',
  containerType: 'Container type',
  exportClearance: 'Export clearance (USD)',
  inlandHaulage: 'Inland haulage (USD)',
  originTHC: 'Origin THC (USD)',
  oceanFreight: 'Ocean freight (USD)',
  destTHC: 'Destination THC (USD)',
  dutyRatePct: 'Import duty rate (%)',
  vatRatePct: 'VAT rate (%)',
};

const OVERRIDE_KEYS = [
  'unitPrice', 'quantity',
  'exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'destTHC',
  'insuranceRatePct', 'dutyRatePct', 'vatRatePct',
];

/** Merge parsed fields with numeric/text overrides. Overrides win. */
function mergeInputs(parsed = {}, overrides = {}) {
  const out = { ...parsed };
  for (const k of ['hsCode', 'originPort', 'destPort', 'containerType', 'incoterm', 'product']) {
    if (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '') out[k] = overrides[k];
  }
  const ov = {};
  for (const k of OVERRIDE_KEYS) {
    const v = overrides[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) ov[k] = n;
  }
  if (ov.unitPrice !== undefined) out.unitPrice = ov.unitPrice;
  if (ov.quantity !== undefined) out.quantity = ov.quantity;
  out.overrides = { ...(parsed.overrides || {}), ...ov };
  return out;
}

function buildQuote(inputs, incotermCode) {
  const code = String(incotermCode || inputs.incoterm || '').toUpperCase();
  const alloc = allocationFor(code);
  const ov = inputs.overrides || {};
  const needs = new Map(); // key -> {key,label,hint}
  const need = (key, hint) => { if (!needs.has(key)) needs.set(key, { key, label: INPUT_LABELS[key] || key, hint }); };
  const warnings = [];

  const originId = R.normalizePort(inputs.originPort);
  const destId = R.normalizePort(inputs.destPort);
  const lane = originId && destId ? R.laneFor(originId, destId) : null;
  const dest = destId ? R.PORTS[destId] : null;
  const country = dest ? R.COUNTRIES[dest.country] : null;
  const ct = ['20ft', '40ft', '40hc'].includes(inputs.containerType) ? inputs.containerType : null;
  const hs6 = R.normalizeHs(inputs.hsCode);
  const hsRow = hs6 ? R.HS[hs6] : null;

  if (!alloc) need('incoterm', 'Pick one of the 11 Incoterms 2020 rules');
  if (!originId) need('originPort', 'Origin port not recognised in the demo lane table');
  if (!destId) need('destPort', 'Destination port not recognised in the demo lane table');
  if (!ct) need('containerType', 'Use 20ft, 40ft or 40hc');

  // ---- goods
  const qty = isNum(inputs.quantity) ? inputs.quantity : null;
  const unitPrice = isNum(inputs.unitPrice) ? inputs.unitPrice : null;
  if (qty === null) need('quantity', 'Not found in the request');
  if (unitPrice === null) need('unitPrice', 'No unit price in the request - the agent does not guess prices');
  const goods = qty !== null && unitPrice !== null ? round2(qty * unitPrice) : null;

  // ---- primary cost lines: override > sample table > unknown
  const pick = (key, tableVal, tableSource, hint) => {
    if (isNum(ov[key])) return { amount: ov[key], source: 'user input' };
    if (isNum(tableVal)) return { amount: tableVal, source: tableSource };
    need(key, hint);
    return { amount: null, source: null };
  };
  const laneSrc = lane ? `${lane.label} (${R.SAMPLE_LABEL})` : null;
  const prim = {
    exportClearance: pick('exportClearance', lane && lane.exportClearance, laneSrc,
      lane ? 'Not in the demo lane table' : 'Lane not in demo table'),
    inlandHaulage: pick('inlandHaulage', null, null, 'Depends on the factory location - not in any table'),
    originTHC: pick('originTHC', lane && ct && lane.originTHC[ct], laneSrc,
      lane ? 'Not in the demo lane table' : 'Lane or container not in demo table'),
    oceanFreight: pick('oceanFreight', lane && ct && lane.oceanFreight[ct], laneSrc,
      lane ? 'Not in the demo lane table' : 'Lane or container not in demo table'),
    destTHC: pick('destTHC', lane && ct && lane.destTHC[ct], laneSrc,
      lane ? 'Not in the demo lane table' : 'Lane or container not in demo table'),
  };

  // ---- insurance (derived)
  const insRate = isNum(ov.insuranceRatePct) ? ov.insuranceRatePct : R.INSURANCE.defaultPct;
  const f = R.INSURANCE.insuredValueFactor;
  const cfr = sumOrNull([goods, prim.exportClearance.amount, prim.inlandHaulage.amount, prim.originTHC.amount, prim.oceanFreight.amount]);
  const k = (f * insRate) / 100;
  const insAmount = cfr !== null ? round2((k * cfr) / (1 - k)) : null;
  const insRequired = alloc ? alloc.insuranceRequired : false;

  // ---- customs value (derived)
  const regime = country ? country.region : null;
  let customsValue = null;
  let customsBasis = null;
  if (regime === 'EU') {
    customsBasis = insRequired ? 'CIF value (price + costs to destination port + insurance)' : 'CFR value (price + costs to destination port)';
    customsValue = insRequired ? sumOrNull([cfr, insAmount]) : cfr;
  } else if (regime === 'US') {
    customsBasis = 'FOB-type value (price + costs up to loading)';
    customsValue = sumOrNull([goods, prim.exportClearance.amount, prim.inlandHaulage.amount, prim.originTHC.amount]);
  }

  // ---- duty (derived)
  let dutyRate = null;
  let dutySource = null;
  if (isNum(ov.dutyRatePct)) { dutyRate = ov.dutyRatePct; dutySource = 'user input'; }
  else if (hsRow && regime && isNum(hsRow[regime])) {
    dutyRate = hsRow[regime];
    dutySource = `${hsRow.sources[regime]} (${R.SAMPLE_LABEL})`;
  } else if (hs6 || regime) {
    need('dutyRatePct', hs6 ? `HS ${R.formatHs(hs6)} has no ${regime || 'destination'} rate in the demo table` : 'HS code missing');
  }
  if (!hs6) need('hsCode', 'No HS code found in the request');
  const duty = dutyRate !== null && customsValue !== null ? round2((customsValue * dutyRate) / 100) : null;

  // ---- VAT (derived)
  let vatRate = null;
  let vatSource = null;
  if (isNum(ov.vatRatePct)) { vatRate = ov.vatRatePct; vatSource = 'user input'; }
  else if (country) { vatRate = country.vatPct; vatSource = `${country.vatSource} (${R.SAMPLE_LABEL})`; }
  else need('vatRatePct', 'Destination country unknown');
  const vat = vatRate !== null && customsValue !== null && duty !== null ? round2(((customsValue + duty) * vatRate) / 100) : null;

  const amounts = {
    exportClearance: prim.exportClearance.amount,
    inlandHaulage: prim.inlandHaulage.amount,
    originTHC: prim.originTHC.amount,
    oceanFreight: prim.oceanFreight.amount,
    insurance: insAmount,
    destTHC: prim.destTHC.amount,
    importDuty: duty,
    importVat: vat,
  };
  const sources = {
    exportClearance: prim.exportClearance.source,
    inlandHaulage: prim.inlandHaulage.source,
    originTHC: prim.originTHC.source,
    oceanFreight: prim.oceanFreight.source,
    insurance: `110% x CIF value x ${insRate}% (sample range ${R.INSURANCE.minPct}-${R.INSURANCE.maxPct}%, ${R.SAMPLE_LABEL})`,
    destTHC: prim.destTHC.source,
    importDuty: dutyRate !== null ? `${dutyRate}% x customs value [${customsBasis || 'n/a'}]; ${dutySource}` : null,
    importVat: vatRate !== null ? `${vatRate}% x (customs value + duty); ${vatSource}` : null,
  };
  const dependsOn = {
    insurance: 'goods value, export clearance, inland haulage, origin THC, ocean freight',
    importDuty: 'customs value and duty rate',
    importVat: 'customs value, duty and VAT rate',
  };

  // ---- assemble lines
  const lines = [{
    key: 'goods', label: LABELS.goods, amount: goods, payer: 'seller', state: goods === null ? 'unknown' : 'known',
    included: goods !== null, optional: false,
    basis: qty !== null && unitPrice !== null ? `${qty} x USD ${unitPrice}` : 'quantity x unit price',
    source: goods === null ? null : 'request / user input',
    note: 'Price paid by the buyer to the seller; always on the seller invoice.',
    dependsOn: goods === null ? 'quantity and unit price' : null,
  }];

  for (const key of LINE_KEYS) {
    const payer = alloc ? alloc.payers[key] : null;
    const optional = key === 'insurance' && alloc ? !alloc.insuranceRequired : false;
    const amount = amounts[key];
    const known = isNum(amount);
    const state = !known ? 'unknown' : optional ? 'optional' : 'known';
    let note = alloc && alloc.notes[key] ? alloc.notes[key] : '';
    if (key === 'importVat' && country && country.vatNote) note = `${country.vatNote} ${note}`.trim();
    lines.push({
      key, label: LABELS[key], amount: known ? amount : null, payer, state,
      included: known && !optional, optional,
      basis: key === 'insurance' ? `110% x CIF x ${insRate}%` : null,
      source: sources[key] || null,
      note,
      dependsOn: !known && dependsOn[key] ? dependsOn[key] : null,
    });
  }

  // lines in this order: goods, then the lead's order
  const order = ['goods', 'exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight', 'insurance', 'destTHC', 'importDuty', 'importVat'];
  lines.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  // ---- totals
  const sellerLines = lines.filter((l) => l.payer === 'seller' && !l.optional);
  const buyerLines = lines.filter((l) => l.payer === 'buyer' && l.key !== 'goods' && !l.optional);
  const sellerMissing = sellerLines.filter((l) => l.amount === null);
  const buyerMissing = buyerLines.filter((l) => l.amount === null);
  const sellerShare = sumOrNull(sellerLines.map((l) => l.amount));
  const buyerThirdParty = sumOrNull(buyerLines.map((l) => l.amount));
  const landedComplete = lines.filter((l) => l.state === 'unknown' && !l.optional).length === 0;
  const landedTotal = landedComplete ? sumOrNull(lines.filter((l) => l.included).map((l) => l.amount)) : null;

  if (alloc && alloc.seaOnly && ct) {
    warnings.push(`${code} is a sea-and-inland-waterway rule. ICC recommends FCA (or CPT/CIP) for containerised cargo delivered to a terminal.`);
  }
  if (code === 'DDP') warnings.push('DDP: the seller becomes responsible for import clearance, duty and VAT in the destination country.');
  if (code === 'EXW') warnings.push('EXW: buyer handles export clearance; often impractical for a foreign buyer.');

  const invoice = {
    issuable: goods !== null && sellerMissing.length === 0,
    total: goods !== null && sellerMissing.length === 0 ? sellerShare : null,
    missing: [...(goods === null ? ['goods'] : []), ...sellerMissing.filter((l) => l.key !== 'goods').map((l) => l.key)],
    lines: sellerLines.filter((l) => l.amount !== null).map((l) => ({ key: l.key, label: l.label, amount: l.amount })),
  };

  return {
    incoterm: alloc ? { code: alloc.code, name: alloc.name, group: alloc.group, delivery: alloc.delivery, risk: alloc.risk,
      insuranceRequired: alloc.insuranceRequired, seaOnly: alloc.seaOnly } : null,
    currency: 'USD',
    sample: R.SAMPLE_LABEL,
    lane: lane ? lane.label : null,
    customsValue, customsBasis,
    lines,
    totals: {
      sellerShare, sellerComplete: sellerMissing.length === 0 && goods !== null,
      buyerThirdParty, buyerComplete: buyerMissing.length === 0,
      landedTotal, landedComplete,
    },
    invoice,
    missingInputs: [...needs.values()],
    warnings,
  };
}

/**
 * Diff two quotes (e.g. CIF v1 -> DAP v2).
 * For each line: payer change, amount change, and the change in the seller invoice amount.
 */
function diffQuotes(a, b) {
  const mapA = Object.fromEntries(a.lines.map((l) => [l.key, l]));
  const mapB = Object.fromEntries(b.lines.map((l) => [l.key, l]));
  const inInvoice = (q, key) => q.invoice.lines.some((l) => l.key === key);
  const changes = [];
  for (const key of Object.keys(mapB)) {
    const la = mapA[key];
    const lb = mapB[key];
    const invA = inInvoice(a, key) ? la.amount : 0;
    const invB = inInvoice(b, key) ? lb.amount : 0;
    const payerChanged = la.payer !== lb.payer;
    const amountChanged = la.amount !== lb.amount;
    const optionalChanged = la.optional !== lb.optional;
    const invoiceDelta = round2((invB || 0) - (invA || 0));
    if (payerChanged || amountChanged || optionalChanged || invoiceDelta !== 0) {
      changes.push({
        key, label: lb.label,
        payerFrom: la.payer, payerTo: lb.payer,
        amountFrom: la.amount, amountTo: lb.amount,
        optionalFrom: la.optional, optionalTo: lb.optional,
        invoiceFrom: invA, invoiceTo: invB, invoiceDelta,
      });
    }
  }
  const from = a.invoice.total;
  const to = b.invoice.total;
  const terms = a.incoterm && b.incoterm && a.incoterm.code !== b.incoterm.code ? {
    from: { code: a.incoterm.code, delivery: a.incoterm.delivery, risk: a.incoterm.risk },
    to: { code: b.incoterm.code, delivery: b.incoterm.delivery, risk: b.incoterm.risk },
  } : null;
  return {
    incotermFrom: a.incoterm ? a.incoterm.code : null,
    incotermTo: b.incoterm ? b.incoterm.code : null,
    invoiceFrom: from, invoiceTo: to,
    invoiceDelta: from !== null && to !== null ? round2(to - from) : null,
    changes, terms,
  };
}

module.exports = { buildQuote, diffQuotes, mergeInputs, LABELS, INPUT_LABELS, OVERRIDE_KEYS, round2 };
