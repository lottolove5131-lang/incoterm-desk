'use strict';
const path = require('path');
const express = require('express');
const { createClient } = require('./paypal');
const { DealService, HttpError } = require('./deals');
const { parseRequest, MODEL } = require('./agent');
const { buildQuote, mergeInputs } = require('./quote');
const { CODES, allocationFor } = require('./incoterms');
const R = require('./rates');

function createApp({ paypal = createClient(), parse = parseRequest, env = process.env } = {}) {
  const app = express();
  const svc = new DealService({ paypal, parse, env });
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error('error:', e.message);
    res.status(status).json({ error: e.message, missing: e.missing });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      paypalMode: paypal.mode,
      badge: paypal.mode === 'mock' ? 'MOCK – sandbox keys not set' : 'PayPal Sandbox',
      llm: process.env.GEMINI_API_KEY ? `gemini:${MODEL}` : 'regex fallback (GEMINI_API_KEY not set)',
      sampleLabel: R.SAMPLE_LABEL,
      incoterms: CODES.map((c) => {
        const a = allocationFor(c);
        return { code: c, name: a.name, group: a.group, delivery: a.delivery, risk: a.risk, insuranceRequired: a.insuranceRequired, payers: a.payers };
      }),
      ports: Object.entries(R.PORTS).map(([id, p]) => ({ id, name: p.name })),
    });
  });

  // Stateless quote: parse + price. Used by curl and the tests.
  app.post('/api/quote', wrap(async (req, res) => {
    const { text, incoterm, overrides } = req.body || {};
    if (!text || typeof text !== 'string') throw new HttpError(400, 'text is required');
    const { fields, source, warnings } = await parse(text);
    const inputs = mergeInputs(fields, overrides || {});
    const quote = buildQuote(inputs, incoterm || fields.incoterm);
    res.json({ parsed: fields, parseSource: source, warnings, quote });
  }));

  app.post('/api/deals', wrap(async (req, res) => {
    const deal = await svc.create((req.body || {}).text, req.body || {});
    res.status(201).json(svc.view(deal));
  }));
  app.get('/api/deals/:id', wrap(async (req, res) => {
    res.json(svc.view(svc._get(req.params.id)));
  }));
  app.post('/api/deals/:id/quote', wrap(async (req, res) => {
    const deal = svc.setWorking(req.params.id, req.body || {});
    res.json(svc.view(deal));
  }));
  app.post('/api/deals/:id/invoice', wrap(async (req, res) => {
    const deal = svc._get(req.params.id);
    await svc.issue(req.params.id);
    res.status(201).json(svc.view(deal));
  }));
  app.post('/api/deals/:id/reissue', wrap(async (req, res) => {
    const deal = svc._get(req.params.id);
    await svc.reissue(req.params.id, req.body || {});
    res.json(svc.view(deal));
  }));
  app.post('/api/deals/:id/refresh', wrap(async (req, res) => {
    const deal = svc._get(req.params.id);
    await svc.refresh(req.params.id);
    res.json(svc.view(deal));
  }));
  app.post('/api/deals/:id/mock-pay', wrap(async (req, res) => {
    const deal = svc._get(req.params.id);
    await svc.mockPay(req.params.id);
    res.json(svc.view(deal));
  }));

  return { app, svc };
}

if (require.main === module) {
  const { app, svc } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Incoterm Desk listening on http://localhost:${port}`);
    console.log(`PayPal mode: ${svc.paypal.mode}${svc.paypal.mode === 'mock' ? ' (MOCK - sandbox keys not set)' : ''}`);
    console.log(`LLM: ${process.env.GEMINI_API_KEY ? MODEL : 'regex fallback (GEMINI_API_KEY not set)'}`);
  });
}

module.exports = { createApp };
