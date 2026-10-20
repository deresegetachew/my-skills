---
name: nestjs-clean-code-ddd-hexagonal
description: Enforces Clean Code, DDD-inspired tactical patterns, Hexagonal (Ports & Adapters) architecture and strictly one class per file for NestJS backends. Use when writing, reviewing or refactoring backend code.
---

# Clean Code, DDD-Inspired Design & Hexagonal Architecture

## Purpose

This skill exists to ensure that:

- the **domain model is explicit and protected**
- infrastructure and frameworks remain **replaceable**
- complexity is **contained**, not leaked
- the codebase remains **understandable to humans and agents**

This is **pragmatic DDD**, not ceremony-driven DDD.

---

## 1. Architectural Dependency Rules (CRITICAL)

### `hex-dependency-direction`
Dependencies MUST always point inward.

Infrastructure → Application → Domain

Forbidden:
- Domain importing NestJS, MongoDB, ORMs, HTTP, or serialization libraries
- Domain importing Infrastructure
- Application importing Infrastructure implementations directly

---

### `hex-inversion-of-control`
**Inversion of Control is mandatory.**

Rules:
- Domain defines interfaces (ports)
- Infrastructure implements interfaces (adapters)
- Application wires implementations together
- No layer “new()s” a concrete dependency it does not own

---

## 2. Domain Layer Rules (CRITICAL)

### `domain-purity`
The Domain layer:
- MUST be framework-agnostic
- MUST compile without NestJS
- MUST not depend on persistence, HTTP, or serialization

Allowed imports:
- Language primitives
- Domain types
- Domain interfaces
- Pure utility logic

---

### `domain-entities`
Entities represent **identity over time**.

Rules:
- Entities have stable IDs
- Equality is based on identity, not value
- Entities encapsulate invariants
- Entities may contain behavior

Avoid:
- Public setters that break invariants
- Entities as mere data bags

---

### `domain-value-objects`
Value Objects represent **conceptual values**.

Rules:
- Immutable by default
- Equality by value
- No identity
- Must validate themselves on creation

Examples:
- EmailAddress
- Money
- Coordinates
- LanguageCode

Value Objects MUST:
- Reject invalid states
- Be reusable across entities

---

### `domain-aggregates`
Aggregates define **consistency boundaries**.

Rules:
- One Aggregate Root per aggregate
- External access only via the root
- Invariants enforced inside the aggregate
- Transactions should not cross aggregate boundaries

Avoid:
- Reaching into child entities directly
- Large aggregates with unrelated responsibilities

---

### `domain-domain-services`
Domain Services are allowed **only** when:

- Logic does not belong to a single entity
- Logic is purely domain-related
- No infrastructure access is required

They must:
- Be stateless
- Operate on domain objects
- Live in the domain layer

---

### `domain-domain-events`
Domain Events represent **facts that happened**.

Rules:
- Named in past tense (`WordPlaced`, `SceneCompleted`)
- Emitted by aggregates
- Contain only necessary data
- Do not trigger infrastructure directly

---

## 3. Application Layer Rules (HIGH)

### `app-message-based-boundary`
**Message-Based Application Boundary**

Controllers publish intentions, not implementations.

Rules:
- Controllers depend ONLY on application ports (CommandBus/QueryBus)
- Controllers publish commands/queries, never call use cases directly
- Handlers implement use cases
- Concrete use cases are NEVER referenced by adapters

Architecture:
```
Controller → CommandBus/QueryBus → Handler (Use Case) → Domain
```

Forbidden:
- Controllers injecting concrete use case classes
- Controllers knowing about handler implementations
- Adapters bypassing the message bus

---

### `app-validation-as-interceptor`
**Validation as an Application Interceptor**

Validation guards the boundary, not the business logic.

Rules:
- Validation is a cross-cutting concern
- Validation executes BEFORE use case logic via interceptor
- Validation is declarative via `@ValidateWith(schema)` decorator
- Use cases assume validated input

Flow:
```
Request → Validation Interceptor → Handler → Domain
```

Principles:
- Handlers focus on orchestration, not validation
- Zod schemas define application-level invariants
- Validation failures prevent handler execution
- Domain validation is separate from input validation

---

### `app-use-cases`
Application layer defines **use cases**.

Rules:
- One class per use case
- Coordinates domain objects
- Handles transactions
- Emits domain events

Must NOT:
- Contain business rules
- Know about HTTP, MongoDB, or frameworks

---

### `app-orchestration-only`
Application services:
- Orchestrate
- Delegate
- Sequence operations

They do NOT:
- Validate domain invariants
- Perform persistence logic directly
- Contain UI or transport logic

---

## 4. Ports & Adapters (Hexagonal)

### `ports-repositories`
Repositories are **ports**, not implementations.

Rules:
- Interfaces live in the domain
- Implementations live in infrastructure
- Domain never knows how persistence works

---

### `ports-external-services`
External systems (APIs, queues, storage):

- Must be accessed via ports
- Must not leak third-party models into the domain
- Must be wrapped behind adapters

---

### `anti-corruption-layer`
An Anti-Corruption Layer (ACL) is REQUIRED when:

- Integrating with legacy systems
- Integrating with third-party APIs
- Consuming unstable or foreign models

ACL Rules:
- Translate external models → domain models
- Prevent leakage of foreign concepts
- Live at the infrastructure boundary

---

## 5. Infrastructure Layer Rules (MEDIUM-HIGH)

### `infra-adapters-only`
Infrastructure code:
- Implements ports
- Talks to DB, APIs, filesystem
- Translates formats (DTO ↔ domain)

It must NOT:
- Contain business rules
- Enforce domain invariants
- Decide workflow or policy

---

### `infra-no-domain-leakage`
Infrastructure:
- Must not expose ORM entities to domain
- Must not return raw DB models
- Must map explicitly

---

## 6. Controllers & Interfaces (HIGH)

### `controllers-thin`
Controllers:
- Parse input
- Call use cases
- Map output

Controllers must NOT:
- Contain business logic
- Access repositories directly
- Perform domain validation

---

## 7. Clean Code Rules (HIGH)

### `clean-single-responsibility`
Every class has one reason to change.

Red flags:
- “Manager”, “Helper”, “Service” doing everything
- Large conditional logic trees
- Cross-cutting concerns mixed with logic

---

### `clean-ubiquitous-language`
Use domain language everywhere.

Rules:
- Names must match domain concepts
- Avoid technical naming in domain code
- Be consistent across layers

---

### `clean-file-naming`
**NestJS follows kebab-case convention for all files.**

Rules:
- **Use Cases**: `create-scene.use-case.ts`, `update-word-in-scene.use-case.ts`
- **Controllers**: `scenes.controller.ts`, `languages.controller.ts`
- **Services**: `scenes.service.ts`, `auth.service.ts`
- **Repositories**: `scenes.repository.ts`, `typeorm-scenes.repository.ts`
- **Modules**: `scenes.module.ts`, `persistence.module.ts`
- **Entities**: `scene.entity.ts`, `language.entity.ts`
- **DTOs**: `create-scene.dto.ts`, `update-language.dto.ts`

**Never use camelCase or PascalCase for file names** in NestJS projects (e.g., ❌ `CreateScene.ts`, ❌ `scenesRepository.ts`).

This follows the official NestJS CLI convention and ensures consistency across the Node.js ecosystem.

---

## 7b. One Thing per File (CRITICAL, enforced by a script)

### `file-one-class`
A file declares **at most one class**.

### `file-class-alone`
A file that declares a class declares **nothing else at the top level that runs**: no free functions, and no arrow
functions assigned to constants. A helper becomes a private method, or moves to its own file. Types, interfaces and
constants such as injection tokens may sit beside the class.

### `file-one-function`
A file without a class **exports at most one function**. An `index.ts` that only re-exports is fine.

### `file-kebab-case`
File names are kebab-case (see `clean-file-naming`).

### `file-domain-pure`
Files under any `domain/` folder import no NestJS, persistence, HTTP or network code, and nothing from
`infrastructure/`.

**Enforced by** `scripts/check_structure.py` in this skill:
- copy it into the project, run it in CI, and list the backend source roots in its config (see the script's header);
- existing violators can go on a legacy list that **only shrinks**: a listed file that now passes fails the check too,
  and new files are never exempt.

---

## 8. Testing Rules (CRITICAL)

### `test-domain-in-isolation`
Domain must be testable:
- Without NestJS
- Without databases
- Without HTTP servers

Mocks allowed ONLY for:
- Ports
- External dependencies

---

### `test-contracts-for-ports`
Every port must have:
- At least one contract test
- Shared tests if multiple implementations exist

---

## 9. Non-Negotiable Constraints

- No framework imports in domain
- No business logic in controllers
- No DB access outside repositories
- No circular dependencies across layers
- No leaking persistence models into domain
- No second class, and no stray functions, in a file (section 7b)

---

## 10. Review Checklist

Before marking work complete:

- [ ] Domain has zero framework imports
- [ ] Value Objects are immutable and validated
- [ ] Aggregates define clear boundaries
- [ ] Ports exist for all external dependencies
- [ ] Anti-Corruption Layers exist where needed
- [ ] Controllers are thin
- [ ] Domain tests run without NestJS
- [ ] `scripts/check_structure.py` passes: one class per file, kebab-case names, a pure domain

---

---

## 11. Practical NestJS Implementation

### Defining Ports (Interfaces)
Ports MUST be defined as interfaces in the Domain layer. To support NestJS Dependency Injection, we also define a `string` or `Symbol` token.

```typescript
// domain/ports/scenes.repository.port.ts
export interface ScenesRepository {
  save(scene: Scene): Promise<void>;
  findById(id: string): Promise<Scene | null>;
}

export const SCENES_REPOSITORY = 'SCENES_REPOSITORY';
```

### Implementing Adapters (Infrastructure)
Adapters implement the port and are decorated with `@Injectable()`.

```typescript
// infra/adapters/persistence/typeorm-scenes.repository.ts
@Injectable()
export class TypeOrmScenesRepository implements ScenesRepository {
  constructor(
    @InjectRepository(SceneEntity)
    private readonly repo: Repository<SceneEntity>,
  ) {}

  async save(scene: Scene): Promise<void> {
    const entity = SceneMapper.toPersistence(scene);
    await this.repo.save(entity);
  }
}
```

### Use Case Registration (Application)
Use Cases are registered as providers. Inject dependencies using the port token.

```typescript
// app/use-cases/create-scene.use-case.ts
@Injectable()
export class CreateSceneUseCase {
  constructor(
    @Inject(SCENES_REPOSITORY)
    private readonly scenesRepo: ScenesRepository,
  ) {}

  async execute(dto: CreateSceneDto): Promise<void> {
    const scene = Scene.create(dto);
    await this.scenesRepo.save(scene);
  }
}
```

### Module Wiring
Use the `provide`/`useClass` pattern to link tokens to implementations.

```typescript
@Module({
  providers: [
    CreateSceneUseCase,
    {
      provide: SCENES_REPOSITORY,
      useClass: TypeOrmScenesRepository,
    },
  ],
})
export class ScenesModule {}
```

## Content Versioning & Immutability Rules

- Published aggregates MUST be immutable.
- Draft aggregates MAY be mutable.
- Publishing MUST create a new version identifier.
- Asset paths MUST be versioned and append-only.
- Repositories MUST NOT update published records in place.
- Rollback is achieved by switching active version pointers, not mutation.

## Success Criteria

- Infrastructure can be replaced without touching domain logic
- New features fit naturally into existing aggregates
- Complexity does not leak across boundaries
- The codebase remains readable after 6–12 months