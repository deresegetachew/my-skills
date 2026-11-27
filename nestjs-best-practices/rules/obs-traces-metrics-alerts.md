---
title: Traces, Metrics, Request IDs and Alerts from Day One
impact: HIGH
impactDescription: Failures nobody sees are failures nobody fixes
tags: observability, opentelemetry, logging, metrics, alerts, ai-cost
---

## Traces, Metrics, Request IDs and Alerts from Day One

Logs alone are not monitoring. Every service ships with:
- structured logs that carry a request id;
- distributed traces across HTTP, jobs and outbound calls;
- metrics for rates, errors, durations and queue depth;
- alerts on the events that mean money or data is at risk.

Use OpenTelemetry (OTLP) so the backend can be swapped freely. Locally: a collector with Grafana, Tempo, Loki and Prometheus. In production: a hosted or self-run backend.

**Incorrect:**

```typescript
this.logger.warn('job dead-lettered', jobId);   // a log line nobody watches
// no request id, no trace, no metric, no alert; AI spend unknown
```

**Correct:**

```typescript
// main.ts: OTel SDK started before Nest (auto-instrument http, pg, queue, fetch); off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
// A global interceptor sets the request id (incoming header, else a new one), puts it on the response and in the log context,
// and adds it to every job enqueued, so a job's logs and spans link back to the request.
this.logger.error({ event: 'job_dead_lettered', queue, jobId, requestId, attempts });
this.metrics.counter('jobs_dead_lettered_total').add(1, { queue });
this.metrics.histogram('model_call_cost_usd').record(cost, { model, purpose });
```

Rules:
- **Logs:** structured JSON (the built-in JSON logger in NestJS 11+, or pino) with `requestId`, `traceId`, a stable `event` name and the entity ids. Never secrets or personal data.
- **Traces:** traces cover incoming requests, jobs, database queries and every outbound call. A trace continues from a request into the jobs it enqueued.
- **Metrics:**
  - request rate, errors and latency per route;
  - job counts per queue and state, with the age of the oldest waiting job;
  - outbound call latency and errors per dependency;
  - for AI: model calls with tokens, cost and duration per purpose.
- **Alerts** (as code, in the repo) fire on:
  - dead-lettered jobs;
  - a 5xx rate above its threshold;
  - a queue backing up;
  - a dependency's breaker opening;
  - billing or sync drift events;
  - AI spend above its daily budget.
  Every alert names the runbook step that resolves it.
- **Health:** health endpoints check the database and the queue ([micro-use-health-checks](micro-use-health-checks.md)).
- **The local stack runs:** a failed job is visible on the dashboard, and opens its trace from its id.

Reference: [devops-use-logging](devops-use-logging.md), [rel-timeouts-everywhere](rel-timeouts-everywhere.md)
