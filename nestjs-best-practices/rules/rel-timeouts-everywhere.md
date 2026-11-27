---
title: Every Outbound Call, Query and Server Socket Has a Timeout
impact: CRITICAL
impactDescription: A missing timeout turns one slow dependency into an outage
tags: reliability, timeouts, retries, circuit-breaker, http, database
---

## Every Outbound Call, Query and Server Socket Has a Timeout

SDK defaults are minutes, or forever. One hung dependency then holds every request, connection and worker slot until the whole service stops. Set an explicit budget everywhere, and fail fast with a clear error.

**Incorrect (defaults everywhere):**

```typescript
const ses = new SESv2Client({});                         // no request timeout
const anthropic = new Anthropic();                       // 10-minute default
const pool = new Pool({ connectionString });             // unbounded pool, no statement timeout
await fetch(url);                                        // waits forever
await app.listen(3000);                                  // Node default server timeouts
```

**Correct (explicit budgets, retries with backoff, breakers):**

```typescript
const ses = new SESv2Client({ requestHandler: new NodeHttpHandler({ connectionTimeout: 2_000, requestTimeout: 5_000 }) });
const anthropic = new Anthropic({ timeout: 120_000, maxRetries: 2 });   // only ever called from workers
const pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
await fetch(url, { signal: AbortSignal.timeout(5_000) });

const server = app.getHttpServer();
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 65_000;   // longer than the load balancer's idle timeout
```

Rules:
- **Timeouts:**
  - Every outbound client gets a connect timeout and a total timeout, set from config, never left to the SDK default: HTTP, SDKs, mail, storage, CDN, models, billing.
  - The database pool has a `max`, and a connection and `statement_timeout`. Long reports run in workers, with their own higher limit.
  - The HTTP server sets `requestTimeout`, `headersTimeout` and `keepAliveTimeout`. A global interceptor cuts handlers at the request budget.
- **Retries and breakers:**
  - Retries are only for safe or idempotent calls: exponential backoff with jitter and a cap.
  - Calls a user waits on get a circuit breaker, so a down dependency fails in milliseconds, not seconds. Use a library such as `@nestjs/resilience`, or a small wrapper; either way it's one shared policy, not ad hoc code per call site.
- **Errors:** a timeout produces a typed error the caller can act on (`{code, message, fix}` for people), and a log line with the dependency's name and the time it took.
- **Tests:** each adapter's contract test proves the timeout against a fake that never answers.

Reference: [rel-no-long-work-in-requests](rel-no-long-work-in-requests.md), [obs-traces-metrics-alerts](obs-traces-metrics-alerts.md)
