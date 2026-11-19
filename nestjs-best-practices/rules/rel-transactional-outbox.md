---
title: Side Effects Go Through a Transactional Outbox and a Durable Queue
impact: CRITICAL
impactDescription: Without it, effects are lost on crash, sent twice, or sent for data that rolled back
tags: reliability, outbox, eventual-consistency, queues, idempotency
---

## Side Effects Go Through a Transactional Outbox and a Durable Queue

When a state change must cause something elsewhere, record the intent **in the same transaction** as the change. A relay then delivers it to a durable queue, and idempotent workers carry it out. Examples:
- an email or webhook;
- a billing quantity sync;
- a cache or CDN purge;
- a search index update;
- a stats event;
- another module's reaction.

This is eventual consistency done on purpose.

A Postgres queue (pg-boss, Graphile Worker, or `@nestjs/outbox`) can be the outbox and the queue at once, because enqueueing is just a row in the same transaction. Postgres then plays the part SNS and SQS play elsewhere.

**Incorrect (inline effect after commit; lost on crash, no retry):**

```typescript
await this.repo.save(account);                 // committed
await this.stripe.setQuantity(account.id, n);  // throws → logged, never retried → billing drifts
```

**Correct:**

```typescript
await this.db.transaction(async (tx) => {
  await this.repo.save(tx, account);
  await this.queue.send(tx, 'billing.sync-quantity', { accountId: account.id }, {
    singletonKey: `qty:${account.id}`, retryLimit: 8, retryBackoff: true,
  });
});

@Processor('billing.sync-quantity')
async handle({ accountId }) {
  const n = await this.counts.billable(accountId);         // read the current truth, not the event's snapshot
  await this.stripe.setQuantity(accountId, n, { idempotencyKey: `qty:${accountId}:${n}` });
}
```

Rules:
- **Same transaction:** every cross-system or cross-module effect is enqueued in the transaction that made the change. Never "save, then call".
- **Handlers:**
  - Handlers are idempotent: keyed on the entity, an idempotency key, or a check of current state. They run at least once, sometimes twice.
  - A handler reads the current state when it can, rather than trusting a stale payload.
  - Use singleton or dedupe keys where only one run may be in flight: per pack, per account, per guide.
- **Retries and dead letters:**
  - Retries back off exponentially, with a cap.
  - Exhausted jobs go to a dead letter that raises an alert ([obs-traces-metrics-alerts](obs-traces-metrics-alerts.md)) and can be retried from an admin screen.
- **Events between modules:** modules react to each other through these events, not by importing each other's internals.

Reference: [rel-durable-background-work](rel-durable-background-work.md), [arch-use-events](arch-use-events.md), [micro-use-queues](micro-use-queues.md)
