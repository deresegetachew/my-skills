---
title: Never Do Slow or Unbounded Work Inside an HTTP Request
impact: CRITICAL
impactDescription: Long requests time out at the proxy, keep billing after the user leaves, and do not scale
tags: reliability, async, queues, http, ai
---

## Never Do Slow or Unbounded Work Inside an HTTP Request

A request handler validates, records intent, enqueues a durable job and answers. It never waits for slow or unbounded work. That means:
- a model or agent call;
- file or PDF processing;
- bundle builds;
- fan-out to third parties;
- anything that can take more than about a second, or whose duration you don't control.

Proxies and CDNs cut requests at 30–60 s. The work keeps running and costs money. The user sees an error. One slow dependency then holds a connection per user.

**The test:** if the handler awaits something whose duration depends on another system's speed or on input size, it belongs in a worker.

**Incorrect (an AI agent runs while the request waits):**

```typescript
@Post(':id/instructions')
async give(@Param('id') id: string, @Body() dto: InstructionDto) {
  // Can run for minutes; the CDN returns 504 at 30 s while the model keeps billing.
  const result = await this.ownerAgent.run(id, dto.text);
  return result;
}
```

**Correct (accept, enqueue in the same transaction, answer 202, report progress):**

```typescript
@Post(':id/instructions')
@HttpCode(202)
async give(@Param('id') id: string, @Body() dto: InstructionDto) {
  const runId = await this.commandBus.execute(new GiveInstructionCommand(id, dto.text));
  return { runId, status: 'queued' }; // the client polls GET /runs/:runId or listens on SSE
}

// Handler: one transaction writes the run row and enqueues the job (outbox or the queue's own table).
// Worker: runs the agent with a hard deadline, retries with backoff, writes the result, idempotent on runId.
```

Rules:
- **Accept and answer:** the request answers within its budget (aim for under 1 s), with `202` and an id when work is queued.
- **Progress:** the client gets progress through polling or SSE, never a held-open request.
- **Workers:** model calls, LLM agents and batch jobs run only in workers, with a deadline (`AbortSignal.timeout`), capped retries, structured-output validation, and per-run cost logging.
- **Failure:** a failed or timed-out job leaves a visible state ("failed, retry") and never hangs silently.

Reference: [rel-timeouts-everywhere](rel-timeouts-everywhere.md), [rel-transactional-outbox](rel-transactional-outbox.md), [micro-use-queues](micro-use-queues.md)
