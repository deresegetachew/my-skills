---
name: saas-launch-playbook
description: Lessons from taking a small SaaS from code to a working staging and toward its first paying customer, for a solo founder or tiny team. Covers hosting on AWS (and what to do when AWS blocks a service), Cloudflare (DNS, R2, Tunnel), Terraform across several providers, secrets, transactional email and a test mailbox, payments and tax with Stripe (Managed Payments versus Stripe Tax), CI and deploys on self-hosted runners, and watching cost. Use when planning or setting up hosting, payments, tax, email, secrets, DNS or deploys for a new app or business, when staging is blocked on a cloud provider, or before taking real money.
---

# SaaS launch playbook

What worked, what blocked, and in which order, when one founder took a web app (an API, a worker, three static
front ends, Postgres) to a working staging and toward its first real payment. Each reference file is one topic.
Read only the one you need.

## The order that avoids waiting

1. **Decide where the business is registered early.** Stripe fixes an account's country, and so does a tax setup.
   You can start in test mode without it, but live payments, tax and some providers' approvals wait on it.
2. **Open the slow approvals on day one, in parallel:**
   - cloud account verification for a CDN (AWS CloudFront can be refused on a new account);
   - email production access (AWS SES starts in a sandbox);
   - payment account activation.
   They take days and need replies from you. Don't let them block staging. See [hosting](references/hosting.md).
3. **Staging first, with stand-ins.** Anything waiting on an approval gets a cheap stand-in that is clearly marked
   staging-only (decision record), so testing never stops.
4. **Test the product as a user on staging** (numbered journeys), then fix what breaks.
5. **Write the going-live checklist as you go.** Test-mode and live-mode settings never carry over (Stripe), and
   sandbox limits (SES) only show at launch. See [payments](references/payments-stripe.md).

## The rules that held

- **The owner enters every secret.** The agent gives a command that reads the value without echoing it and pipes
  it straight into the secret store; the agent never sees, prints or pastes it. See [secrets](references/secrets.md).
- **Everything in Terraform, applied from one place.** Several providers (AWS, Cloudflare) in one plan. One
  bootstrap token per provider is made by hand; Terraform makes every narrower key. See
  [terraform](references/terraform.md).
- **Read every plan before applying.** "Harmless" re-renders hide real breaks (a task definition re-registered with
  a placeholder image tag). See [terraform](references/terraform.md).
- **Staging applies without asking; production, secrets and spending stay the owner's.** Agree this once and
  write it down.
- **One self-hosted machine is a single point of failure.** If deploys run only there, keep it awake and watch its
  queue. See [CI and deploys](references/ci-and-deploys.md).
- **Check the bill weekly from the first day,** by service. The surprise is rarely compute. See
  [costs](references/costs.md).

## Reference files

| File | Read it when |
|---|---|
| [hosting.md](references/hosting.md) | choosing where the app runs, or a cloud service is refused |
| [cloudflare.md](references/cloudflare.md) | moving DNS, serving files without egress fees, exposing an API without opening ports |
| [terraform.md](references/terraform.md) | setting up or applying infrastructure across providers |
| [secrets.md](references/secrets.md) | storing keys for local, staging and production |
| [email.md](references/email.md) | sending sign-in codes or receipts, and testing email end to end |
| [payments-stripe.md](references/payments-stripe.md) | subscriptions, tax, webhooks, and going live |
| [ci-and-deploys.md](references/ci-and-deploys.md) | CI quotas, self-hosted runners, deploy pipelines |
| [costs.md](references/costs.md) | reading the bill and cutting it |
