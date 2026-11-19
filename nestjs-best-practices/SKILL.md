---
name: nestjs-best-practices
description: NestJS best practices and architecture patterns for building production-ready applications. This skill should be used when writing, reviewing, or refactoring NestJS code to ensure proper patterns for modules, dependency injection, security, and performance.
---

# NestJS Best Practices

Comprehensive best practices guide for NestJS applications. Contains 46 rules across 12 categories, prioritized by impact to guide automated refactoring and code generation.

## When to Apply

Reference these guidelines when:

- Writing new NestJS modules, controllers, or services
- Implementing authentication and authorization
- Reviewing code for architecture and security issues
- Refactoring existing NestJS codebases
- Optimizing performance or database queries
- Building microservices architectures

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Architecture | CRITICAL | `arch-` |
| 2 | Reliability & Async Flows | CRITICAL | `rel-` |
| 3 | Dependency Injection | CRITICAL | `di-` |
| 4 | Error Handling | HIGH | `error-` |
| 5 | Security | HIGH | `security-` |
| 6 | Observability | HIGH | `obs-` |
| 7 | Performance | HIGH | `perf-` |
| 8 | Testing | MEDIUM-HIGH | `test-` |
| 9 | Database & ORM | MEDIUM-HIGH | `db-` |
| 10 | API Design | MEDIUM | `api-` |
| 11 | Microservices | MEDIUM | `micro-` |
| 12 | DevOps & Deployment | LOW-MEDIUM | `devops-` |

## Quick Reference

### 1. Architecture (CRITICAL)

- `arch-avoid-circular-deps` - Avoid circular module dependencies
- `arch-feature-modules` - Organize by feature, not technical layer
- `arch-module-sharing` - Proper module exports/imports, avoid duplicate providers
- `arch-single-responsibility` - Focused services over "god services"
- `arch-use-repository-pattern` - Abstract database logic for testability
- `arch-use-events` - Event-driven architecture for decoupling

### Reliability & Async Flows (CRITICAL)

A reviewer blocks a change that breaks one of these, even if every test passes.

- `rel-no-long-work-in-requests` - Requests accept, enqueue and answer; model calls, file processing and other slow work run in workers
- `rel-timeouts-everywhere` - Every outbound call, DB query and server socket has an explicit timeout; retries back off; breakers on hot paths
- `rel-no-network-in-transactions` - Only DB work inside a transaction; effects after commit, last step last
- `rel-transactional-outbox` - Cross-system effects enqueued in the same transaction; idempotent handlers; dead letters alert
- `rel-durable-background-work` - No fire-and-forget promises, setTimeout/setInterval schedulers or in-memory dedupe

### Observability (HIGH)

- `obs-traces-metrics-alerts` - OpenTelemetry traces and metrics, request ids into jobs, AI cost metrics, alerts as code

### 2. Dependency Injection (CRITICAL)

- `di-avoid-service-locator` - Avoid service locator anti-pattern
- `di-interface-segregation` - Interface Segregation Principle (ISP)
- `di-liskov-substitution` - Liskov Substitution Principle (LSP)
- `di-prefer-constructor-injection` - Constructor over property injection
- `di-scope-awareness` - Understand singleton/request/transient scopes
- `di-use-interfaces-tokens` - Use injection tokens for interfaces

### 3. Error Handling (HIGH)

- `error-use-exception-filters` - Centralized exception handling
- `error-throw-http-exceptions` - Use NestJS HTTP exceptions
- `error-handle-async-errors` - Handle async errors properly

### 4. Security (HIGH)

- `security-auth-jwt` - Secure JWT authentication
- `security-validate-all-input` - Validate with class-validator
- `security-use-guards` - Authentication and authorization guards
- `security-sanitize-output` - Prevent XSS attacks
- `security-rate-limiting` - Implement rate limiting

### 5. Performance (HIGH)

- `perf-async-hooks` - Proper async lifecycle hooks
- `perf-use-caching` - Implement caching strategies
- `perf-optimize-database` - Optimize database queries
- `perf-lazy-loading` - Lazy load modules for faster startup

### 6. Testing (MEDIUM-HIGH)

- `test-use-testing-module` - Use NestJS testing utilities
- `test-e2e-supertest` - E2E testing with Supertest
- `test-mock-external-services` - Mock external dependencies

### 7. Database & ORM (MEDIUM-HIGH)

- `db-use-transactions` - Transaction management
- `db-avoid-n-plus-one` - Avoid N+1 query problems
- `db-use-migrations` - Use migrations for schema changes

### 8. API Design (MEDIUM)

- `api-use-dto-serialization` - DTO and response serialization
- `api-use-interceptors` - Cross-cutting concerns
- `api-versioning` - API versioning strategies
- `api-use-pipes` - Input transformation with pipes

### 9. Microservices (MEDIUM)

- `micro-use-patterns` - Message and event patterns
- `micro-use-health-checks` - Health checks for orchestration
- `micro-use-queues` - Background job processing (see also the `rel-` rules, which are CRITICAL)

### 10. DevOps & Deployment (LOW-MEDIUM)

- `devops-use-config-module` - Environment configuration
- `devops-use-logging` - Structured logging
- `devops-graceful-shutdown` - Zero-downtime deployments

## How to Use

Read individual rule files for detailed explanations and code examples in the [rules/](rules/) directory.

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Use together with

- **`nestjs-clean-code-ddd-hexagonal`** for the architecture: hexagonal layers, a pure domain, use cases behind a
  CommandBus and QueryBus, and strictly one class per file. Where the two skills overlap, the hexagonal skill decides
  the structure. For example, `arch-feature-modules` means one Nest module per bounded context, each holding its own
  `domain/`, `application/`, `infrastructure/` and `interface/` folders.

## Project adaptations

A project may differ from a rule only through a recorded decision, for example a `docs/decisions/NNNN-*.md` file that
names the rule and the reason. Common examples:
- Zod pipes instead of class-validator;
- session cookies instead of JWT;
- plain SQL through `pg` instead of an ORM.

Reviewers treat an undocumented difference as a finding.

## Full Compiled Document

For the complete guide with all rules expanded, see [AGENTS.md](AGENTS.md).
