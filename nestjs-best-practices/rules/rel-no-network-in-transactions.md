---
title: Never Call the Network Inside a Database Transaction
impact: CRITICAL
impactDescription: External effects can't roll back; the system ends up pointing at data that doesn't exist
tags: reliability, transactions, consistency, outbox
---

## Never Call the Network Inside a Database Transaction

A transaction can roll back, but an upload, an email, a payment or a CDN change can't. If you call them inside a transaction and the commit then fails, the outside world points at a state the database never kept. Meanwhile the transaction holds row locks, and a pool connection, for as long as the slowest network call takes.

**Incorrect (upload and switch pointers, then commit):**

```typescript
await this.db.transaction(async (tx) => {
  const version = await this.versions.create(tx, guideId);
  const bundle = await this.compiler.build(version);       // CPU-heavy work while holding locks
  await this.storage.put(bundle);                          // network
  await this.edge.setPointer(guideId, version.id);         // network: now live
  await this.guides.markPublished(tx, guideId, version.id);
}); // if this commit fails, the live pointer names a rolled-back version
```

**Correct (commit the decision and an outbox event; effects follow in idempotent jobs, last step last):**

```typescript
await this.db.transaction(async (tx) => {
  const version = await this.versions.create(tx, guideId, { state: 'publishing' });
  await this.outbox.add(tx, new GuidePublishRequested(guideId, version.id));
});
// Worker, retried with backoff:
//   build and upload the bundle, using a key per version so a re-run overwrites the same object;
//   switch the pointer, only after the upload succeeded;
//   mark the version live in its own short transaction, or mark it failed and alert after the last retry.
```

Rules:
- **Inside a transaction:** only database work. No HTTP, SDK, storage, mail, queue publish or `await` on another system, unless that system is the same database (for example a queue table such as pg-boss's, written through the same transaction).
- **After commit:** effects go through the outbox ([rel-transactional-outbox](rel-transactional-outbox.md)). Order the steps so a partial failure leaves the old state working: upload, then switch the pointer, then mark live.
- **Keep it short:** a transaction lasts milliseconds. Move CPU-heavy work (builds, image processing) out of it, and usually into a worker.
- **Visible states:** the user sees the intermediate state ("publishing…") until the effect is done.
