# Incoterm Desk

An AI agent for exporters. Type a buyer request in plain English; the agent extracts the deal, prices a
landed-cost breakdown that is **colour-coded by who pays under the chosen Incoterms 2020 rule**, and issues a
**PayPal invoice for the seller's share**. When the buyer switches Incoterm (say CIF to DDP), it re-quotes,
cancels invoice v1, issues v2 and shows exactly which lines and amounts changed.

> All rates, fees and tariffs in this repository are **sample data for demo**. Nothing here is a quote,
> an official tariff or legal advice.

## The problem

Small exporters lose money and time on one sentence: "Can you do DAP instead of CIF?" Every Incoterm moves
costs (export clearance, haulage, terminal handling, freight, insurance, duty, VAT) between seller and buyer.
Quotes live in spreadsheets, the invoice is re-typed by hand, and a wrong line is discovered after the
buyer has paid. AI assistants make it worse when they confidently invent a duty rate or a freight price.

Incoterm Desk fixes the loop:

1. The AI only does language: it turns a message into structured fields.
2. A deterministic engine does the maths, from clearly labelled tables.
3. **Anything it does not know stays "unknown - needs input".** It never makes up a number.
4. PayPal Invoicing is the system of record for what the buyer owes; a change of terms is a new invoice version,
   not an edit.

## Demo flow (about 2 minutes)

1. Click **Sample 1**: "Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container."
   The agent extracts product, HS code, quantity, Incoterm, container and destination. There is no price and no
   origin port in the message, so every amount shows **unknown - needs input**, and the invoice button is blocked.
2. Click **Sample 2** (adds "USD 8.50 each, shipping from Busan"). Lane rates fill in from the sample table, but
   **inland haulage** is deliberately not in any table (it depends on the factory location), so it still asks.
   Enter 350 and click *Apply & re-quote*. Seller-borne lines are blue, buyer-borne lines are amber.
3. Click **Issue PayPal invoice v1** (seller share only: goods plus the lines the seller bears under CIF).
4. Click another Incoterm (FOB, DAP, DDP ...). The breakdown recolours instantly. A red button appears:
   *Buyer accepts DDP: cancel v1 & issue v2*. Click it: v1 shows CANCELLED, v2 is SENT, and the diff lists every
   changed line (payer, amount, invoice delta) and the changed delivery point and risk transfer.
5. **Simulate buyer payment** (mock mode) or pay the sandbox invoice as a sandbox buyer; **Refresh status** polls
   PayPal and the timeline records every step.

## Architecture

```
public/index.html      single-page UI (vanilla JS, no build step)
src/server.js          Express API + static files
src/agent.js           LLM extraction adapter (Gemini REST) + regex fallback + output verification
src/quote.js           deterministic landed-cost engine, unknown propagation, quote diff
src/incoterms.js       Incoterms 2020 cost-allocation matrix (11 rules), cites ICC
src/rates.js           clearly labelled SAMPLE lanes, HS duty rates, VAT, insurance rate
src/deals.js           deal state: invoice versions, cancel/re-issue, timeline
src/paypal.js          PayPal Invoicing v2 client (OAuth, create draft, send, cancel, get) + MOCK mode
tests/*.test.js        node:test suites (49 tests)
```

Key design rules:

- **The LLM never sees prices to compute and never produces amounts.** Its JSON is checked against the original
  text: a quantity, price, HS code, port or Incoterm that does not literally appear in the request is dropped and
  reported as a warning. If no `GEMINI_API_KEY` is set (or the call fails) a regex parser is used.
- **Unknown propagates.** If any input of a derived line is unknown (for example freight for insurance, customs
  value for duty and VAT) that line is unknown too, never 0.
- **Seller invoice = goods + seller-borne required lines.** Optional lines (for example insurance outside CIF/CIP)
  are shown as estimates and excluded from totals and the invoice.
- **Re-issue is safe.** The new draft is created first, the old invoice is cancelled second, the new one is sent
  last; a failure never leaves the deal without a valid invoice.

### Simplifications (documented in the code)

EU customs value = CIF/CFR value; US customs value = FOB-type value; EU VAT base = customs value + duty; US sample
VAT = 0 (state sales tax not modelled); FCA assumes the named place is the origin terminal; DAP leaves destination
handling with the buyer unless the carriage contract says otherwise (ICC A9/B9). Check your own contract.

## Run it

Requires Node.js 20+.

```bash
npm install
npm test            # 49 tests
npm start           # http://localhost:3000
```

Optional environment (see `.env.example`; never commit `.env`):

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Enables the Gemini extraction (`gemini-flash-lite-latest`, free tier). Without it the regex parser is used. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal **sandbox** REST app credentials. Without them the app runs in **MOCK** mode and shows the badge "MOCK - sandbox keys not set". |
| `PAYPAL_INVOICER_EMAIL`, `PAYPAL_BUYER_EMAIL` | Sandbox business and buyer accounts for the invoice. |
| `PORT` | Default 3000. |

```bash
node --env-file=.env src/server.js
curl -s -X POST localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"text":"Buyer in Rotterdam wants 2,400 units of HS 8504.40 power adapters, CIF Rotterdam, 40ft container."}'
```

### PayPal sandbox notes

- Create a REST app in the PayPal Developer Dashboard (sandbox) with Invoicing enabled, and put its client id and secret in `.env`.
- `PAYPAL_INVOICER_EMAIL` must be the sandbox **business** account that owns the app.
- PayPal blocks invoices from a Korean merchant to a Korean payer (`KOREAN_MERCHANT_KOREAN_PAYER_RESTRICTED`). If your sandbox business account is KR, use a non-KR buyer email (any address works; it does not need a PayPal account).
- Payment terms use `NET_15`, so the due date is set to invoice date + 15 days (PayPal rejects other due dates for that term).

### API

`POST /api/quote` (stateless parse + price) - `POST /api/deals` - `POST /api/deals/:id/quote` (switch Incoterm / add
inputs) - `POST /api/deals/:id/invoice` (issue v1) - `POST /api/deals/:id/reissue` (cancel active, issue next, diff) -
`POST /api/deals/:id/refresh` - `POST /api/deals/:id/mock-pay` (mock only) - `GET /api/config`.

PayPal calls follow the Invoicing v2 reference (https://developer.paypal.com/docs/api/invoicing/v2/):
`POST /v1/oauth2/token`, `POST /v2/invoicing/invoices`, `POST .../{id}/send`, `POST .../{id}/cancel`, `GET .../{id}`
against `https://api-m.sandbox.paypal.com`.

## AI tools disclosure

- **Runtime:** Google Gemini (`gemini-flash-lite-latest`, free tier) extracts structured fields from the buyer
  request. Its output is verified against the source text; it does not compute or supply any amount.
- **Development:** Anthropic Claude (via Claude Code) proposed the idea and drafted the code, tests and this README. The entrant reviewed, ran and approved the work. The Incoterms allocation was cross-checked against the ICC Incoterms 2020 rules and a public summary table; rates are placeholders.
- No customer data, company data or credentials are in this repository.

## License

MIT, see `LICENSE`.
