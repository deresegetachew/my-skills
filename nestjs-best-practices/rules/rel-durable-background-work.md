---
title: No In-Memory Background Work, Timers or Dedupe
impact: CRITICAL
impactDescription: In-process work vanishes on deploy and doubles with a second replica
tags: reliability, background-jobs, scheduling, scaling
---

## No In-Memory Background Work, Timers or Dedupe

Work that outlives the request must survive a restart, and must run once when there are two replicas. In-process promises, `setTimeout` or `setInterval` schedulers, in-memory retry loops and in-memory "already running" sets fail both tests.
- A deploy drops the work.
- A second replica runs it again, and pays for it twice.

**Incorrect:**

```typescript
void this.translatePack(packId);                  // fire-and-forget: lost on restart
const running = new Set<string>();                // dedupe per process only
setTimeout(() => this.purgeCdn(paths), 30_000);   // retry held in memory
setInterval(() => this.sendWeeklyStats(), WEEK);  // runs once per replica
```

**Correct:**

```typescript
await this.queue.send('translate.pack', { packId }, { singletonKey: `pack:${packId}` });
await this.queue.send('cdn.purge', { paths }, { retryLimit: 10, retryBackoff: true });
await this.queue.schedule('stats.weekly', '0 7 * * MON', {}, { tz: 'UTC' });   // one run cluster-wide
```

Rules:
- **No in-process background work:** no `void promise`, no un-awaited background calls, no in-memory retry loops in request or application code. Background work is a durable job.
- **Schedules:** use the queue's cron, or a lock, so they run once across replicas. Never `setInterval` or chained `setTimeout`.
- **Dedupe:** use the queue's singleton keys, a unique constraint, or an advisory lock. Never an in-memory Set or Map.
- **Shutdown:** graceful shutdown stops taking new jobs and finishes or releases the current ones ([devops-graceful-shutdown](devops-graceful-shutdown.md)).
- **Tests:**
  - A restart in the middle of a job leaves it to be picked up again.
  - Two workers on the same key run it once.
