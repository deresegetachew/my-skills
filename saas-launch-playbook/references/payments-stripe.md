# Payments and tax with Stripe

## Seller of record: decide before the first customer

| | Stripe Managed Payments | Stripe Tax |
|---|---|---|
| Who sells | Stripe (merchant of record) | your business |
| Tax registration and filing | Stripe, in 80+ countries | you, in each country (or an accountant) |
| Fraud, disputes, payment support | Stripe | you |
| Cost seen Nov 2026 | 3.5% per successful transaction, on top of card fees | about 0.5% per transaction (check), plus registration and filing costs |

- For a solo founder selling software worldwide, **Managed Payments** is far less work.
- It is only for digital products sold directly (SaaS, software, digital content), by a business in a supported
  country (US, CA, most of the EU, GB, CH, NO, AU, HK, JP, SG at the time). Each product needs an eligible tax code
  (SaaS business use: `txcd_10103001`).
- **Only new subscriptions** created through a Managed Payments Checkout Session qualify; existing ones can't move.
- Restrictions: subscriptions only through Checkout or Payment Links; no setting `default_payment_method` by API;
  no invoice items or one-off invoices on those customers; no third-party tax integrations. Updating a
  subscription (quantity, cancel at period end) by API is allowed.
- Stripe fixes the account's country when it is created; changing it means a new account. Test mode works in any
  country.

## Integration that held up

- Hosted **Checkout Session** in `subscription` mode, `managed_payments[enabled]=true`,
  `subscription_data[billing_mode][type]=flexible`, and a pinned `Stripe-Version` that has both. Plain HTTPS without
  the SDK is fine.
- A per-unit price (one unit per billed item), quantity updated by the app as items are added or removed.
- Price shown with **tax on top** for B2B (`tax_behavior=exclusive`; dashboard "Include tax in prices": No).
- **Customer portal** for card updates, invoices and cancel at period end; quantity changes and plan switching
  **off** (the app owns the quantity). Save the portal once in test mode before it works.
- **Revenue recovery:** Smart Retries on (8 tries in 2 weeks was the default); failed-card and expiring-card emails on,
  linked to Stripe's hosted page (a default custom link can be invalid).
- A setting to switch Managed Payments off, defaulting **on**: off by mistake creates subscriptions that can never
  move. When the account isn't enabled, answer the user "billing isn't set up" and log the fix; never log keys or
  Stripe's error text.

## Webhooks

- Webhook (not EventBridge) unless you need events inside AWS: no extra consumer, and Stripe retries for up to 3 days.
- **Snapshot** payloads; events `customer.subscription.created/updated/deleted` and `invoice.paid` were enough.
- Handle it fast in the request: verify the signature in memory, then **one short database transaction** that
  records the event id (repeats stop there), updates the account and writes follow-up work (emails, cache updates)
  to an outbox. No network calls inside the request. A failure answers an error and Stripe retries.
- The agent can create the endpoint in the dashboard; the owner reveals and stores the signing secret.

## Test mode versus live mode

Nothing carries over. Keep a **going-live checklist** in the journeys document: activate the account (business, ID,
bank), support email, Terms and Privacy links, Managed Payments on, live product and tax code, live price id and keys,
live webhook, live portal, live recovery settings, a check that a portal cancel survives a later quantity change in
flexible billing mode, and one real purchase and refund with the owner's card.

## Tools

- `stripe` CLI (npm `@stripe/cli`, published by Stripe) for products, prices and checks; `stripe login` is the
  owner's step.
- `stripe tools plan --message "<full business context>"` gives a decision-tree plan; read it, answer the trees with
  the user's facts, accept with the chosen leaves. It surfaced Managed Payments when the user had asked for Stripe Tax.
- English docs as Markdown: `curl -H 'Accept-Language: en-US' https://docs.stripe.com/<page>.md`.
