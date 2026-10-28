'use strict';
/*
 * Request-extraction agent.
 *
 * Adapter: Google Gemini (free tier) via REST, model "gemini-flash-lite-latest", key from env
 * GEMINI_API_KEY (never committed). Falls back to a deterministic regex parser when no key is
 * set or the call fails.
 *   Docs: https://ai.google.dev/api/generate-content
 *
 * The agent returns JSON and must never invent numbers: every numeric / code field coming back
 * from the model is verified against the user's original text (sanitize()). A value that does
 * not literally appear in the request is dropped to null and reported in `warnings`.
 */

const R = require('./rates');
const { CODES } = require('./incoterms');

const MODEL = 'gemini-flash-lite-latest';
const ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const FIELDS = ['product', 'hsCode', 'quantity', 'unitPrice', 'originPort', 'destPort', 'incoterm', 'containerType'];
const EMPTY = () => Object.fromEntries(FIELDS.map((f) => [f, null]));

function containerFrom(text) {
  const m = /\b(20|40)\s?(?:-?\s?)(?:ft|foot|feet|')\s*(hc|high[\s-]?cube)?/i.exec(text)
    || /\b(20|40)\s*(hc|high[\s-]?cube)\b/i.exec(text);
  if (!m) return null;
  if (m[1] === '20') return '20ft';
  return m[2] ? '40hc' : '40ft';
}

function parseWithRegex(text) {
  const t = String(text || '');
  const out = EMPTY();

  const q = /(\d[\d,]*(?:\.\d+)?)\s*(?:units?|pcs|pieces?|sets?|cartons?|pairs?)\b/i.exec(t);
  if (q) out.quantity = Number(q[1].replace(/,/g, ''));

  const hs = /\bHS(?:\s*code)?\s*[:#]?\s*(\d{4}(?:[.\s]?\d{2}){0,2})/i.exec(t);
  if (hs) out.hsCode = R.formatHs(hs[1]) || hs[1].replace(/\s/g, '');

  const p = /(?:USD|US\$|\$)\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*(?:unit|pc|piece|each|ea)|per\s+(?:unit|pc|piece)|each\b|ea\b)/i.exec(t);
  if (p) out.unitPrice = Number(p[1].replace(/,/g, ''));

  const inc = new RegExp(`\\b(${CODES.join('|')})\\b`, 'i').exec(t);
  if (inc) out.incoterm = inc[1].toUpperCase();

  out.containerType = containerFrom(t);

  // product: words after the HS code, or after "units of"
  let prod = null;
  const afterHs = /\bHS(?:\s*code)?\s*[:#]?\s*\d{4}(?:[.\s]?\d{2}){0,2}\s+([a-z][a-z \-/]{2,40}?)(?=\s*(?:,|\.|;|\bat\b|\bfrom\b|\bto\b|\bin\b|\bunder\b|\bwith\b|$)|\s+(?:USD|US\$|\$)|\s+(?:EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b)/i.exec(t);
  const afterUnits = /\b(?:units?|pcs|pieces?|sets?|cartons?)\s+of\s+([a-z][a-z \-/]{2,40}?)(?=\s*(?:,|\.|;|\bat\b|\bfrom\b|\bto\b|$)|\s+(?:EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b)/i.exec(t);
  if (afterHs) prod = afterHs[1];
  else if (afterUnits) prod = afterUnits[1];
  if (prod) out.product = prod.trim().replace(/\s+/g, ' ');

  // ports: classify known port mentions by the word that precedes them
  const hits = R.findPortsInText(t);
  const lower = t.toLowerCase();
  const incotermWord = `(?:${CODES.join('|')})`.toLowerCase();
  for (const h of hits) {
    const before = lower.slice(Math.max(0, h.index - 28), h.index).trimEnd();
    const isOrigin = /(?:\bfrom|\bex|\bloading at|\borigin|\bshipping from|\b(?:exw|fca|fas|fob))$/.test(before);
    const isDest = new RegExp(`(?:\\bto|\\bin|\\bdestination|\\bfor|\\b(?:cfr|cif|cpt|cip|dap|dpu|ddp))$`).test(before);
    if (isOrigin && !out.originPort) out.originPort = R.PORTS[h.id].name;
    else if (isDest && !out.destPort) out.destPort = R.PORTS[h.id].name;
  }
  // unrecognised destination named after a D/C-group rule: keep raw text, it will be "needs input"
  if (!out.destPort && out.incoterm && /^(CFR|CIF|CPT|CIP|DAP|DPU|DDP)$/.test(out.incoterm)) {
    const m = new RegExp(`\\b${out.incoterm}\\s+([A-Z][A-Za-z]+(?:\\s[A-Z][A-Za-z]+)?)`).exec(t);
    if (m) out.destPort = m[1];
  }
  return out;
}

/** Verify model output against the source text. Returns {fields, warnings}. */
function sanitize(text, raw) {
  const warnings = [];
  const out = EMPTY();
  const src = String(text || '');
  const srcNoComma = src.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const lower = src.toLowerCase();
  const r = raw && typeof raw === 'object' ? raw : {};

  const numberInText = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
    const re = new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}(?:\\.0+)?(?![\\d])`);
    return re.test(srcNoComma) || re.test(srcNoComma.replace(/(\d+\.\d*?)0+\b/g, '$1'));
  };
  const asNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : null);

  const qty = asNum(r.quantity);
  if (qty !== null) {
    if (numberInText(qty)) out.quantity = qty; else warnings.push(`quantity ${qty} is not in the request - dropped`);
  }
  const price = asNum(r.unitPrice);
  if (price !== null) {
    if (numberInText(price)) out.unitPrice = price; else warnings.push(`unit price ${price} is not in the request - dropped`);
  }
  if (r.hsCode) {
    const d = String(r.hsCode).replace(/\D/g, '');
    if (d.length >= 4 && src.replace(/\D/g, ' ').replace(/\s+/g, '').includes(d)) out.hsCode = R.formatHs(d) || String(r.hsCode);
    else warnings.push(`HS code ${r.hsCode} is not in the request - dropped`);
  }
  if (r.incoterm) {
    const c = String(r.incoterm).toUpperCase().trim();
    if (CODES.includes(c) && new RegExp(`\\b${c}\\b`, 'i').test(src)) out.incoterm = c;
    else warnings.push(`Incoterm ${r.incoterm} is not stated in the request - dropped`);
  }
  for (const key of ['originPort', 'destPort']) {
    if (!r[key]) continue;
    const v = String(r[key]).trim();
    if (lower.includes(v.toLowerCase())) out[key] = R.normalizePort(v) ? R.PORTS[R.normalizePort(v)].name : v;
    else warnings.push(`${key} "${v}" is not in the request - dropped`);
  }
  if (r.containerType) {
    const c = String(r.containerType).toLowerCase().replace(/\s/g, '');
    const norm = c === '20ft' ? '20ft' : c === '40ft' ? '40ft' : (c === '40hc' || c === '40ft hc' || c === '40ft-hc') ? '40hc' : null;
    if (norm && containerFrom(src) === norm) out.containerType = norm;
    else warnings.push(`container type "${r.containerType}" does not match the request - dropped`);
  }
  if (r.product) {
    const v = String(r.product).trim().slice(0, 80);
    if (v && lower.includes(v.toLowerCase().split(' ')[0])) out.product = v;
    else warnings.push(`product "${v}" not found in the request - dropped`);
  }
  return { fields: out, warnings };
}

const SYSTEM = [
  'You extract structured fields from an exporter\'s buyer-request message.',
  'Return ONLY a JSON object with keys: product, hsCode, quantity, unitPrice, originPort, destPort, incoterm, containerType.',
  'Rules: use null for anything not literally stated. NEVER guess or compute numbers. quantity and unitPrice are plain numbers (unitPrice per unit in USD).',
  'incoterm is one of EXW,FCA,FAS,FOB,CPT,CIP,CFR,CIF,DAP,DPU,DDP. containerType is one of 20ft,40ft,40hc.',
  'originPort is the port of shipment, destPort the port of destination, as written in the text.',
].join(' ');

async function callGemini(text, { apiKey, fetchImpl = fetch, model = MODEL, timeoutMs = 15000 }) {
  const res = await fetchImpl(ENDPOINT(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const part = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0];
  if (!part || typeof part.text !== 'string') throw new Error('Gemini returned no text');
  return JSON.parse(part.text.replace(/^```json\s*|```$/g, '').trim());
}

/** Main entry. Returns {fields, source, warnings}. */
async function parseRequest(text, opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.GEMINI_API_KEY;
  const regexFields = parseWithRegex(text);
  if (!apiKey) return { fields: regexFields, source: 'regex', warnings: [] };
  try {
    const raw = await callGemini(text, { apiKey, fetchImpl: opts.fetchImpl });
    const { fields, warnings } = sanitize(text, raw);
    // Fill gaps the model left null with the deterministic parser (still text-grounded).
    for (const k of FIELDS) if (fields[k] === null && regexFields[k] !== null) fields[k] = regexFields[k];
    return { fields, source: `gemini:${MODEL}`, warnings };
  } catch (e) {
    return { fields: regexFields, source: 'regex', warnings: [`LLM unavailable (${e.message}); used regex fallback`] };
  }
}

module.exports = { parseRequest, parseWithRegex, sanitize, callGemini, FIELDS, MODEL };
