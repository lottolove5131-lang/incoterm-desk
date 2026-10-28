'use strict';
/*
 * Incoterms 2020 cost-allocation matrix.
 *
 * Source of truth: ICC, "Incoterms 2020" (ICC Publication 723E), the A9/B9 "Allocation of costs"
 * articles and the A4/A6/A7 articles of each rule. Public overview:
 *   https://iccwbo.org/business-solutions/incoterms-rules/incoterms-2020/
 *   https://en.wikipedia.org/wiki/Incoterms  (summary table used for cross-checking)
 * This is a simplified model for a demo: it covers the cost lines the app prices, for
 * containerised sea freight. It is NOT legal advice; real contracts can shift items.
 *
 * Cost lines (keys): exportClearance, inlandHaulage, originTHC, oceanFreight, insurance,
 * destTHC, importDuty, importVat. "goods" is the price the buyer pays the seller and is
 * always on the seller's invoice.
 */

const LINE_KEYS = [
  'exportClearance', 'inlandHaulage', 'originTHC', 'oceanFreight',
  'insurance', 'destTHC', 'importDuty', 'importVat',
];

const S = 'seller';
const B = 'buyer';

const row = (a) => Object.fromEntries(LINE_KEYS.map((k, i) => [k, a[i]]));

const ALLOCATION = {
  //        expClr inland oTHC  freight ins  dTHC  duty  vat
  EXW: row([B, B, B, B, B, B, B, B]),
  FCA: row([S, S, B, B, B, B, B, B]),
  FAS: row([S, S, B, B, B, B, B, B]),
  FOB: row([S, S, S, B, B, B, B, B]),
  CPT: row([S, S, S, S, B, B, B, B]),
  CIP: row([S, S, S, S, S, B, B, B]),
  CFR: row([S, S, S, S, B, B, B, B]),
  CIF: row([S, S, S, S, S, B, B, B]),
  DAP: row([S, S, S, S, S, B, B, B]),
  DPU: row([S, S, S, S, S, S, B, B]),
  DDP: row([S, S, S, S, S, B, S, S]),
};

// Insurance is a mandatory seller obligation only under CIF (min. ICC (C)) and CIP (ICC (A)).
// Under DAP/DPU/DDP the seller carries the risk but is not obliged to insure; elsewhere
// insurance is the buyer's own choice. In those cases the line is shown as an optional estimate.
const INSURANCE_REQUIRED = { CIF: 'ICC (C) minimum cover', CIP: 'ICC (A) minimum cover' };

const META = {
  EXW: { name: 'Ex Works', group: 'E', seaOnly: false, delivery: "Seller's premises (goods placed at buyer's disposal, not loaded)", risk: "Passes when goods are placed at buyer's disposal at the seller's premises" },
  FCA: { name: 'Free Carrier', group: 'F', seaOnly: false, delivery: 'Handed to the buyer-nominated carrier at the named place', risk: 'Passes at hand-over to the carrier' },
  FAS: { name: 'Free Alongside Ship', group: 'F', seaOnly: true, delivery: 'Alongside the vessel at the named port of shipment', risk: 'Passes when goods are alongside the vessel' },
  FOB: { name: 'Free On Board', group: 'F', seaOnly: true, delivery: 'On board the vessel at the named port of shipment', risk: 'Passes when goods are on board the vessel' },
  CPT: { name: 'Carriage Paid To', group: 'C', seaOnly: false, delivery: 'Handed to the first carrier (seller pays carriage to the named place)', risk: 'Passes at hand-over to the first carrier' },
  CIP: { name: 'Carriage and Insurance Paid To', group: 'C', seaOnly: false, delivery: 'Handed to the first carrier (seller pays carriage and insurance)', risk: 'Passes at hand-over to the first carrier' },
  CFR: { name: 'Cost and Freight', group: 'C', seaOnly: true, delivery: 'On board the vessel at the port of shipment (seller pays freight to the named port)', risk: 'Passes when goods are on board the vessel' },
  CIF: { name: 'Cost, Insurance and Freight', group: 'C', seaOnly: true, delivery: 'On board the vessel at the port of shipment (seller pays freight and insurance)', risk: 'Passes when goods are on board the vessel' },
  DAP: { name: 'Delivered at Place', group: 'D', seaOnly: false, delivery: 'At the named place of destination, ready for unloading', risk: 'Passes on arrival at the named place, ready for unloading' },
  DPU: { name: 'Delivered at Place Unloaded', group: 'D', seaOnly: false, delivery: 'At the named place of destination, unloaded', risk: 'Passes once unloaded at the named place' },
  DDP: { name: 'Delivered Duty Paid', group: 'D', seaOnly: false, delivery: 'At the named place of destination, import-cleared, ready for unloading', risk: 'Passes on arrival at the named place, ready for unloading' },
};

const NOTES = {
  EXW: {
    exportClearance: 'Buyer arranges export clearance under EXW (2020). Often impractical for a foreign buyer; ICC suggests FCA instead.',
    inlandHaulage: "Buyer collects at the seller's premises.",
  },
  FCA: {
    originTHC: 'Assumes the named place is the origin terminal: loading onto the vessel happens after hand-over to the carrier, so the buyer side bears it unless the contract says otherwise.',
  },
  FAS: {
    originTHC: 'Loading onto the vessel is for the buyer under FAS. ICC recommends FCA instead of FAS/FOB for containers.',
  },
  FOB: {
    originTHC: 'Seller pays loading on board. ICC recommends FCA instead of FOB for containers delivered to a terminal.',
  },
  CFR: { insurance: 'No insurance duty on the seller; buyer insures at own discretion.' },
  CIF: { insurance: 'Seller must insure for 110% of the price (ICC (C) minimum cover).' },
  CIP: { insurance: 'Seller must insure for 110% of the price (ICC (A) cover under the 2020 rules).' },
  DAP: {
    destTHC: "Unloading at destination is the buyer's (B9) unless the seller's contract of carriage already covers it (A9).",
    insurance: 'Seller carries the risk to destination but is not obliged to insure.',
  },
  DPU: {
    destTHC: 'Seller unloads at the named place, so destination handling is on the seller.',
    insurance: 'Seller carries the risk to destination but is not obliged to insure.',
  },
  DDP: {
    importDuty: 'Seller clears the goods for import and pays duty. Seller must be able to act as importer of record in the destination country.',
    importVat: 'Seller pays import VAT under DDP; recoverability depends on the destination VAT regime.',
    insurance: 'Seller carries the risk to destination but is not obliged to insure.',
  },
};

function allocationFor(code) {
  const c = String(code || '').toUpperCase();
  if (!ALLOCATION[c]) return null;
  return {
    code: c,
    ...META[c],
    insuranceRequired: Boolean(INSURANCE_REQUIRED[c]),
    insuranceCover: INSURANCE_REQUIRED[c] || null,
    payers: { ...ALLOCATION[c] },
    notes: { ...(NOTES[c] || {}) },
  };
}

const CODES = Object.keys(ALLOCATION);

module.exports = { LINE_KEYS, ALLOCATION, META, NOTES, INSURANCE_REQUIRED, CODES, allocationFor };
