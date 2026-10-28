'use strict';
/*
 * PayPal Invoicing v2 client (sandbox) with a MOCK mode.
 *
 * Official docs (payload shapes, status enum, endpoints):
 *   Overview:      https://developer.paypal.com/docs/api/invoicing/v2/
 *   OAuth 2.0:     https://developer.paypal.com/api/rest/authentication/
 *   Machine spec:  https://developer.paypal.com/api/invoicing/v2/schema.json
 *
 * Endpoints used (base https://api-m.sandbox.paypal.com):
 *   POST /v1/oauth2/token                          client_credentials, HTTP Basic auth
 *   POST /v2/invoicing/invoices                    create draft -> 201 (link with the new invoice href;
 *                                                  body returned if header Prefer: return=representation)
 *   POST /v2/invoicing/invoices/{id}/send          body = notification {subject,note,send_to_invoicer,
 *                                                  send_to_recipient,additional_recipients} -> 200 / 202
 *   POST /v2/invoicing/invoices/{id}/cancel        same notification body -> 204 (only for SENT invoices)
 *   GET  /v2/invoicing/invoices/{id}               -> invoice with `status`
 * Invoice status enum: DRAFT, SENT, SCHEDULED, PAID, MARKED_AS_PAID, CANCELLED, REFUNDED,
 *   PARTIALLY_PAID, PARTIALLY_REFUNDED, MARKED_AS_REFUNDED, UNPAID, PAYMENT_PENDING,
 *   AUTO_CANCELLED, PAID_EXTERNAL, REFUNDED_EXTERNAL, SHARED.
 * If invoice_number is omitted PayPal auto-increments it (schema: invoice_detail.invoice_number).
 *
 * Credentials: env PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Without them the client runs in MOCK
 * mode: same response shapes, in-memory state, clearly flagged on screen.
 */

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

class MockPayPal {
  constructor() { this.mode = 'mock'; this.invoices = new Map(); this.seq = 0; }

  async createDraft(payload) {
    this.seq += 1;
    const id = `INV2-MOCK-${String(this.seq).padStart(4, '0')}`;
    const number = payload.detail && payload.detail.invoice_number ? payload.detail.invoice_number : `MOCK-${String(this.seq).padStart(4, '0')}`;
    const total = payload.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_amount.value), 0);
    this.invoices.set(id, {
      id, status: 'DRAFT',
      detail: { ...payload.detail, invoice_number: number },
      invoicer: payload.invoicer, primary_recipients: payload.primary_recipients, items: payload.items,
      amount: { currency_code: payload.detail.currency_code, value: total.toFixed(2) },
      links: [],
    });
    return { id, href: `${SANDBOX_BASE}/v2/invoicing/invoices/${id}`, number, mock: true };
  }

  _get(id) {
    const inv = this.invoices.get(id);
    if (!inv) { const e = new Error(`MOCK: invoice ${id} not found`); e.status = 404; throw e; }
    return inv;
  }

  async send(id) {
    const inv = this._get(id);
    if (inv.status !== 'DRAFT') { const e = new Error('MOCK: only DRAFT invoices can be sent'); e.status = 422; throw e; }
    inv.status = 'SENT';
    return { rel: 'self', href: `${SANDBOX_BASE}/v2/invoicing/invoices/${id}`, method: 'GET' };
  }

  async cancel(id) {
    const inv = this._get(id);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING'].includes(inv.status)) {
      const e = new Error(`MOCK: cannot cancel an invoice in status ${inv.status}`); e.status = 422; throw e;
    }
    inv.status = 'CANCELLED';
    return { cancelled: true };
  }

  async get(id) { return JSON.parse(JSON.stringify(this._get(id))); }

  /** Mock-only helper: the real sandbox is paid by a sandbox buyer on PayPal's hosted page. */
  async simulatePayment(id) {
    const inv = this._get(id);
    if (!['SENT', 'UNPAID'].includes(inv.status)) { const e = new Error(`MOCK: cannot pay an invoice in status ${inv.status}`); e.status = 422; throw e; }
    inv.status = 'PAID';
    return { status: 'PAID' };
  }
}

class SandboxPayPal {
  constructor({ clientId, clientSecret, base = SANDBOX_BASE, fetchImpl = fetch }) {
    this.mode = 'sandbox';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = base;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExp = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExp - 30000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw await this._error(res, 'OAuth token request failed');
    const j = await res.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + (Number(j.expires_in) || 300) * 1000;
    return this.token;
  }

  async _error(res, msg) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* ignore */ }
    const e = new Error(`${msg}: HTTP ${res.status} ${body.slice(0, 300)}`);
    e.status = res.status;
    return e;
  }

  async _req(method, path, body, extraHeaders = {}) {
    const token = await this.accessToken();
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  }

  async createDraft(payload) {
    const res = await this._req('POST', '/v2/invoicing/invoices', payload, { Prefer: 'return=representation' });
    if (res.status !== 201) throw await this._error(res, 'Create draft invoice failed');
    const j = await res.json();
    const id = j.id || (j.href && j.href.split('/').pop());
    return { id, href: j.href || `${this.base}/v2/invoicing/invoices/${id}`, number: j.detail && j.detail.invoice_number };
  }

  async send(id, notification = {}) {
    const res = await this._req('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      send_to_invoicer: true, send_to_recipient: true, ...notification,
    });
    if (res.status !== 200 && res.status !== 202) throw await this._error(res, 'Send invoice failed');
    return res.status === 200 ? res.json() : { accepted: true };
  }

  async cancel(id, notification = {}) {
    const res = await this._req('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      send_to_invoicer: true, send_to_recipient: true, ...notification,
    });
    if (res.status !== 204) throw await this._error(res, 'Cancel invoice failed');
    return { cancelled: true };
  }

  async get(id) {
    const res = await this._req('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    if (!res.ok) throw await this._error(res, 'Get invoice failed');
    return res.json();
  }
}

function createClient(env = process.env, fetchImpl) {
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return new SandboxPayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, fetchImpl });
  }
  return new MockPayPal();
}

/**
 * Build the create-draft payload (schema: invoice -> detail, invoicer, primary_recipients, items).
 * `quote.invoice.lines` is the seller's share; goods are expressed as quantity x unit price.
 */
function buildInvoicePayload({ dealId, version, quote, inputs, env = process.env, supersedes = null }) {
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.parse(today) + 15 * 86400000).toISOString().slice(0, 10);
  const items = quote.invoice.lines.map((l) => {
    if (l.key === 'goods') {
      return {
        name: `Goods: ${inputs.product || 'goods'}${inputs.hsCode ? ` (HS ${inputs.hsCode})` : ''}`.slice(0, 200),
        description: `${quote.incoterm.code} price basis`,
        quantity: String(inputs.quantity),
        unit_amount: { currency_code: quote.currency, value: Number(inputs.unitPrice).toFixed(2) },
        unit_of_measure: 'QUANTITY',
      };
    }
    return {
      name: l.label,
      description: `Seller-borne under ${quote.incoterm.code} (sample data for demo)`,
      quantity: '1',
      unit_amount: { currency_code: quote.currency, value: Number(l.amount).toFixed(2) },
      unit_of_measure: 'AMOUNT',
    };
  });
  return {
    detail: {
      reference: `${dealId}-v${version}`,
      invoice_date: today,
      currency_code: quote.currency,
      note: `Incoterms 2020: ${quote.incoterm.code} ${inputs.destPort || ''}`.trim() + (supersedes ? `. Supersedes ${supersedes}.` : ''),
      term: 'Sandbox demo invoice. Sample data for demo.',
      memo: `Incoterm Desk deal ${dealId} v${version}`,
      payment_term: { term_type: 'NET_15', due_date: due },
    },
    invoicer: {
      name: { business_name: env.SELLER_NAME || 'Demo Exporter Co. (sample)' },
      email_address: env.PAYPAL_INVOICER_EMAIL || 'seller@example.com',
    },
    primary_recipients: [{
      billing_info: {
        name: { business_name: env.BUYER_NAME || 'Demo Buyer BV (sample)' },
        email_address: env.PAYPAL_BUYER_EMAIL || 'buyer@example.com',
      },
    }],
    items,
    configuration: { allow_tip: false, tax_inclusive: false },
  };
}

module.exports = { createClient, buildInvoicePayload, MockPayPal, SandboxPayPal, SANDBOX_BASE };
