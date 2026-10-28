'use strict';
/*
 * SAMPLE DATA FOR DEMO ONLY. None of these values is a quote, a tariff or legal advice.
 * Every value is labelled "sample data for demo" in the UI. Anything missing here is
 * deliberately missing: the app must say "unknown - needs input" instead of inventing it.
 *
 * Official sources to replace the samples with:
 *   EU duty: TARIC      https://ec.europa.eu/taxation_customs/dds2/taric/
 *   US duty: USITC HTS  https://hts.usitc.gov/
 *   EU VAT:  EC rates   https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en
 */

const SAMPLE_LABEL = 'sample data for demo';

// Ports and aliases (lowercase), keyed by UN/LOCODE.
const PORTS = {
  KRPUS: { name: 'Busan', country: 'KR', aliases: ['pusan'] },
  KRINC: { name: 'Incheon', country: 'KR', aliases: ['inchon'] },
  NLRTM: { name: 'Rotterdam', country: 'NL', aliases: [] },
  USLAX: { name: 'Los Angeles', country: 'US', aliases: ['la port', 'port of la'] },
  DEHAM: { name: 'Hamburg', country: 'DE', aliases: [] },
};

// Destination-country import regime used for customs value and VAT.
const COUNTRIES = {
  NL: { name: 'Netherlands', region: 'EU', vatPct: 21, vatSource: 'https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en' },
  DE: { name: 'Germany', region: 'EU', vatPct: 19, vatSource: 'https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en' },
  US: { name: 'United States', region: 'US', vatPct: 0, vatSource: 'https://hts.usitc.gov/',
        vatNote: 'No federal VAT. State sales tax is not modelled.' },
};

// Amounts in USD per container type (20ft, 40ft, 40hc). `null` = not in the demo table -> unknown.
// inlandHaulage is intentionally NOT in any table: it depends on the factory location.
const LANES = {
  'KRPUS-NLRTM': {
    label: 'Busan -> Rotterdam',
    exportClearance: 40,
    oceanFreight: { '20ft': 1650, '40ft': 2850, '40hc': 2950 },
    originTHC: { '20ft': 150, '40ft': 190, '40hc': 190 },
    destTHC: { '20ft': 260, '40ft': 330, '40hc': 330 },
  },
  'KRPUS-USLAX': {
    label: 'Busan -> Los Angeles',
    exportClearance: 40,
    oceanFreight: { '20ft': 1350, '40ft': 2150, '40hc': 2250 },
    originTHC: { '20ft': 150, '40ft': 190, '40hc': 190 },
    destTHC: { '20ft': 330, '40ft': 420, '40hc': 420 },
  },
  'KRINC-DEHAM': {
    label: 'Incheon -> Hamburg',
    exportClearance: null, // deliberately missing in the demo table
    oceanFreight: { '20ft': null, '40ft': 2990, '40hc': 3090 },
    originTHC: { '20ft': 155, '40ft': 200, '40hc': 200 },
    destTHC: { '20ft': 270, '40ft': 345, '40hc': 345 },
  },
};

// HS 6-digit -> duty % per region. A missing region means unknown.
const HS = {
  '850440': { desc: 'Static converters (e.g. power adapters)', EU: 3.3, US: 0,
    sources: { EU: 'https://ec.europa.eu/taxation_customs/dds2/taric/', US: 'https://hts.usitc.gov/' } },
  '610910': { desc: 'T-shirts, knitted, of cotton', EU: 12, US: 16.5,
    sources: { EU: 'https://ec.europa.eu/taxation_customs/dds2/taric/', US: 'https://hts.usitc.gov/' } },
  '950300': { desc: 'Toys (tricycles, dolls, models, puzzles)', EU: 0, US: 0,
    sources: { EU: 'https://ec.europa.eu/taxation_customs/dds2/taric/', US: 'https://hts.usitc.gov/' } },
  '392690': { desc: 'Other articles of plastics', US: 5.3, // EU intentionally absent
    sources: { US: 'https://hts.usitc.gov/' } },
};

// Cargo insurance: premium = 110% x CIF value x rate, rate typically 0.1%-0.3% (sample range).
const INSURANCE = { minPct: 0.1, maxPct: 0.3, defaultPct: 0.2, insuredValueFactor: 1.1 };

const ALL_ALIASES = () => {
  const out = [];
  for (const [id, p] of Object.entries(PORTS)) {
    for (const a of [p.name.toLowerCase(), ...p.aliases]) out.push({ id, alias: a });
  }
  return out;
};

function normalizePort(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  for (const [id, p] of Object.entries(PORTS)) {
    if (id.toLowerCase() === t || p.name.toLowerCase() === t || p.aliases.includes(t)) return id;
  }
  return null;
}

function findPortsInText(text) {
  const t = String(text || '').toLowerCase();
  const hits = [];
  for (const { id, alias } of ALL_ALIASES()) {
    const re = new RegExp(`\\b${alias.replace(/ /g, '\\s+')}\\b`, 'g');
    let m;
    while ((m = re.exec(t))) hits.push({ id, index: m.index, length: m[0].length });
  }
  return hits.sort((a, b) => a.index - b.index);
}

function normalizeHs(code) {
  if (!code) return null;
  const d = String(code).replace(/\D/g, '');
  return d.length >= 6 ? d.slice(0, 6) : null;
}

function formatHs(code) {
  const d = normalizeHs(code);
  return d ? `${d.slice(0, 4)}.${d.slice(4, 6)}` : null;
}

function laneFor(originId, destId) {
  return LANES[`${originId}-${destId}`] || null;
}

module.exports = {
  SAMPLE_LABEL, PORTS, COUNTRIES, LANES, HS, INSURANCE,
  normalizePort, findPortsInText, normalizeHs, formatHs, laneFor,
};
