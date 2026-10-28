'use strict';
/*
 * Deal service: one exporter deal = request text + parsed fields + chosen Incoterm +
 * invoice versions (v1, v2, ...) + status timeline. In-memory (demo).
 */
const crypto = require('crypto');
const { parseRequest } = require('./agent');
const { buildQuote, diffQuotes, mergeInputs } = require('./quote');
const { buildInvoicePayload } = require('./paypal');

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const LIVE = ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'PAID', 'MARKED_AS_PAID', 'DRAFT', 'SCHEDULED'];

class DealService {
  constructor({ paypal, parse = parseRequest, env = process.env }) {
    this.paypal = paypal;
    this.parse = parse;
    this.env = env;
    this.deals = new Map();
  }

  _event(deal, type, message, data) {
    deal.timeline.push({ at: new Date().toISOString(), type, message, ...(data ? { data } : {}) });
  }

  _get(id) {
    const d = this.deals.get(id);
    if (!d) throw new HttpError(404, 'deal not found');
    return d;
  }

  inputsOf(deal) { return mergeInputs(deal.parsed, deal.overrides); }

  quoteOf(deal, incoterm = deal.incoterm) {
    return buildQuote(this.inputsOf(deal), incoterm);
  }

  active(deal) {
    for (let i = deal.invoices.length - 1; i >= 0; i--) {
      if (deal.invoices[i].status !== 'CANCELLED') return deal.invoices[i];
    }
    return null;
  }

  view(deal) {
    const quote = this.quoteOf(deal);
    const act = this.active(deal);
    return {
      id: deal.id,
      text: deal.text,
      parsed: deal.parsed,
      parseSource: deal.parseSource,
      warnings: deal.warnings,
      overrides: deal.overrides,
      incoterm: deal.incoterm,
      inputs: this.inputsOf(deal),
      quote,
      invoices: deal.invoices,
      activeVersion: act ? act.version : null,
      canReissue: Boolean(act) && !['PAID', 'MARKED_AS_PAID'].includes(act.status),
      paypalMode: this.paypal.mode,
      timeline: deal.timeline,
    };
  }

  async create(text, { incoterm, overrides } = {}) {
    const t = String(text || '').trim();
    if (!t) throw new HttpError(400, 'text is required');
    if (t.length > 4000) throw new HttpError(400, 'text too long');
    const { fields, source, warnings } = await this.parse(t);
    const deal = {
      id: `deal-${crypto.randomBytes(3).toString('hex')}`,
      text: t,
      parsed: fields,
      parseSource: source,
      warnings,
      overrides: overrides || {},
      incoterm: String(incoterm || fields.incoterm || '').toUpperCase() || null,
      invoices: [],
      timeline: [],
    };
    this._event(deal, 'request', 'Buyer request received');
    this._event(deal, 'parsed', `Fields extracted by ${source}`, fields);
    this.deals.set(deal.id, deal);
    const q = this.quoteOf(deal);
    this._event(deal, 'quote', `Quote built under ${deal.incoterm || 'no Incoterm'}; ${q.missingInputs.length} input(s) missing`);
    return deal;
  }

  /** Update the working Incoterm / overrides without touching invoices (preview). */
  setWorking(id, { incoterm, overrides } = {}) {
    const deal = this._get(id);
    if (incoterm) deal.incoterm = String(incoterm).toUpperCase();
    if (overrides && typeof overrides === 'object') deal.overrides = { ...deal.overrides, ...overrides };
    return deal;
  }

  async _issue(deal, quote, supersedes) {
    if (!quote.incoterm) throw new HttpError(422, 'Choose an Incoterm first', { missing: ['incoterm'] });
    if (!quote.invoice.issuable) {
      throw new HttpError(422, 'Invoice cannot be issued: the seller share still has unknown amounts', { missing: quote.invoice.missing });
    }
    const inputs = this.inputsOf(deal);
    const version = deal.invoices.length + 1;
    const payload = buildInvoicePayload({ dealId: deal.id, version, quote, inputs, env: this.env, supersedes });
    const draft = await this.paypal.createDraft(payload);
    this._event(deal, 'invoice_draft', `Invoice v${version} draft created (${draft.id})`);
    return { version, draft, quote, payload };
  }

  async issue(id) {
    const deal = this._get(id);
    if (this.active(deal)) throw new HttpError(409, 'An active invoice already exists; use re-issue');
    const quote = this.quoteOf(deal);
    const { version, draft } = await this._issue(deal, quote, null);
    await this.paypal.send(draft.id, { subject: `Invoice v${version} (${quote.incoterm.code})`, note: `Priced under ${quote.incoterm.code}.` });
    const inv = this._record(deal, version, draft, quote, 'SENT', null);
    this._event(deal, 'invoice_sent', `Invoice v${version} sent: seller share USD ${quote.invoice.total.toFixed(2)} under ${quote.incoterm.code}`);
    return inv;
  }

  _record(deal, version, draft, quote, status, diff) {
    const inv = {
      version, paypalId: draft.id, href: draft.href, number: draft.number || null, status,
      incoterm: quote.incoterm.code, total: quote.invoice.total, lines: quote.invoice.lines,
      createdAt: new Date().toISOString(), cancelledAt: null, diffFromPrevious: diff,
    };
    deal.invoices.push(inv);
    deal.snapshots = deal.snapshots || {};
    deal.snapshots[version] = quote;
    return inv;
  }

  /** Buyer switches Incoterm (or fixes an input): re-quote, cancel active vN, issue vN+1, return the diff. */
  async reissue(id, { incoterm, overrides } = {}) {
    const deal = this._get(id);
    const prev = this.active(deal);
    if (!prev) throw new HttpError(409, 'No active invoice to re-issue; issue v1 first');
    if (['PAID', 'MARKED_AS_PAID'].includes(prev.status)) throw new HttpError(409, 'Invoice already paid; cannot re-issue');
    const before = deal.incoterm;
    const beforeOverrides = deal.overrides;
    const oldQuote = this._quoteFromInvoice(deal, prev);
    this.setWorking(id, { incoterm, overrides });
    const quote = this.quoteOf(deal);
    let drafted;
    try {
      drafted = await this._issue(deal, quote, `v${prev.version} (${prev.incoterm})`);
    } catch (e) {
      deal.incoterm = before; deal.overrides = beforeOverrides; // nothing changed on failure
      throw e;
    }
    const { version, draft } = drafted;
    this._event(deal, 'incoterm_switch', `Buyer switched ${prev.incoterm} -> ${quote.incoterm.code}`);
    // Cancel the old invoice only after the new draft exists, so a failure never leaves the deal invoice-less.
    await this.paypal.cancel(prev.paypalId, {
      subject: `Invoice v${prev.version} cancelled`,
      note: `Superseded by v${version} (Incoterm ${prev.incoterm} -> ${quote.incoterm.code}).`,
    });
    prev.status = 'CANCELLED';
    prev.cancelledAt = new Date().toISOString();
    this._event(deal, 'invoice_cancelled', `Invoice v${prev.version} cancelled`);
    await this.paypal.send(draft.id, { subject: `Invoice v${version} (${quote.incoterm.code})`, note: `Replaces v${prev.version}.` });
    const diff = diffQuotes(oldQuote, quote);
    const inv = this._record(deal, version, draft, quote, 'SENT', diff);
    this._event(deal, 'invoice_sent', `Invoice v${version} sent: seller share USD ${quote.invoice.total.toFixed(2)} (${diff.invoiceDelta >= 0 ? '+' : ''}${diff.invoiceDelta.toFixed(2)})`);
    return inv;
  }

  _quoteFromInvoice(deal, inv) {
    return (deal.snapshots && deal.snapshots[inv.version]) || buildQuote(this.inputsOf(deal), inv.incoterm);
  }

  async refresh(id) {
    const deal = this._get(id);
    const act = this.active(deal) || deal.invoices[deal.invoices.length - 1];
    if (!act) throw new HttpError(409, 'No invoice yet');
    const remote = await this.paypal.get(act.paypalId);
    if (remote.status && remote.status !== act.status) {
      act.status = remote.status;
      this._event(deal, 'status', `Invoice v${act.version} status: ${remote.status}`);
    }
    return act;
  }

  async mockPay(id) {
    if (this.paypal.mode !== 'mock') throw new HttpError(400, 'Payment simulation exists in MOCK mode only; pay the sandbox invoice as the sandbox buyer');
    const deal = this._get(id);
    const act = this.active(deal);
    if (!act) throw new HttpError(409, 'No active invoice');
    await this.paypal.simulatePayment(act.paypalId);
    return this.refresh(id);
  }
}

module.exports = { DealService, HttpError, LIVE };
