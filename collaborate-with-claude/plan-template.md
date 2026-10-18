# Software Factory Blueprint: [Feature / System Title]

> **Autonomous AI Software Factory Contract (Gemini + Claude)**  
> *Notice to Models*: Adhere strictly to the Factory Stage Gates. Do not proceed to code manufacturing without Human Spec Sign-Off.

| Factory Lifecycle Gate | Current Status | Gate Keeper |
| :--- | :--- | :--- |
| **🛡️ Gate 1: Spec & Architecture** | `[ 🛡️ PENDING_HUMAN_SPEC_REVIEW ]` | Human Developer / Lead |
| **⚙️ Station 3: Manufacturing** | `[ ⏳ WAITING_ON_GATE_1 ]` | Gemini + Claude CLI |
| **🔬 Station 4: Quality Control** | `[ ⏳ PENDING ]` | Cross-Model Audit |
| **🚀 Gate 2: Final Acceptance** | `[ ⏳ PENDING ]` | Human Developer / Lead |

---

## 1. Executive Product Objective
[Concise summary of the task, user problem, business outcome, and architectural scope in 2-3 sentences.]

---

## 2. Target Files & Scope Boundaries
*Read and edit ONLY these explicit files:*
- `path/to/Component.tsx` (Lines [StartLine]-[EndLine]): [Purpose of change]
- `path/to/styles.css` (Lines [StartLine]-[EndLine]): [Purpose of change]
- `path/to/types.ts` (Lines [StartLine]-[EndLine]): [Interface/type contract updates]

---

## 3. Ergonomic UX & Typographic Hierarchy (Claude Strategy)
- **Typographic Scale**:
  - Title/Display: [Font family, size token e.g. text-2xl/font-bold, tracking e.g. tracking-tight, line-height 1.1-1.2]
  - Body Copy: [Font family, size e.g. text-base/leading-relaxed, optimal measure e.g. max-w-prose (45-75 chars)]
  - Micro-copy / Captions: [Font size e.g. text-xs/font-medium, uppercase tracking +0.02em]
- **Spatial Rhythm & Layout**:
  - Grid: [4px / 8px grid tokens e.g. gap-4, p-6]
  - Visual Grouping: [Miller's Law: max 5-7 active choices without progressive disclosure]
- **Interaction States & Affordances**:
  - Focus visible: [Crisp ring affordances e.g. focus-visible:ring-2 focus-visible:ring-offset-2]
  - Empty / Error recovery: [Clear message + actionable primary button]
  - Accessibility Target: [WCAG 2.1 AA / AAA compliant contrast]

---

## 4. Architecture & Component Contracts
```typescript
// Strict TypeScript prop and state contracts
export interface ComponentProps {
  // Define strict types here (no loose 'any')
}
```

- **Separation of Concerns**: [Keep presentation stateless; encapsulate logic in custom hooks or containers]
- **Anti-patterns to Avoid**: [No unnecessary useEffects, no inline large styles, no unhandled error states]

---

## 5. Gemini Codebase Grounding & Feasibility Audit
> *Filled by Gemini after auditing Claude's plan against the 1M+ token repository context.*
- **Feasibility & Architectural Fit**: [Analysis of how the plan aligns with existing codebase patterns]
- **Discovered Reusable Utilities**: [Existing hooks, helpers, or API clients to reuse]
- **Potential Breaking Changes & Edge Cases**: [Schema incompatibilities, performance bottlenecks]
- **Recommended Adjustments**: [Specific adjustments suggested by Gemini]

---

## 🛡️ Human Review Bucket 1: Spec & Architecture Gate
> **Human Developer Review**: *Authorize manufacturing by signing off below.*

- [ ] **Requirements**: Feature solve the core user intent without scope creep.
- [ ] **UX & Ergonomics**: Typographic hierarchy and accessibility standards are clear.
- [ ] **Task Allocation**: Division of labor between Gemini and Claude is approved.

**Human Decision**: `[ 🛡️ PENDING | ✅ SPEC_APPROVED | ❌ REVISIONS_REQUESTED ]`  
**Developer Notes / Revisions**: [Add any specific directives here before models start coding]

---

## 6. Dynamic Task Allocation Matrix (Station 3: Manufacturing)
*Unlock this section once Gate 1 is marked `✅ SPEC_APPROVED`.*

| Task / Deliverable | Assignee | Status | Target File(s) |
| :--- | :--- | :--- | :--- |
| Component spec & design tokens | **Claude** | Done | `src/types/`, `src/styles/` |
| Scaffolding, API routes & DB plumbing | **Gemini (AGY)** | In Progress | `src/server/`, `prisma/` |
| Ergonomic UI & interaction states | **Claude** | Pending | `src/components/` |
| Test suite & edge case mocks | **Gemini (AGY)** | Pending | `src/__tests__/` |
| Architectural code review on diff | **Claude** | Pending | `git diff` |

---

## 7. Quality Control & Cross-Model Audit (Station 4: QC)
- [ ] **Claude Senior Architect Diff Review**: [Passed / Regressions flagged]
- [ ] **Gemini Automated Test Suite**: [Passed 100% green]
- [ ] **Typecheck & Linting**: [`npm run typecheck` clean]
- [ ] **Diff Scope Audit**: [Zero unintended files modified]

---

## 🚀 Human Review Bucket 2: Final Acceptance & Release Gate
> **Final Human Sign-Off**: *Inspect live build and approve merge.*

- [ ] **Interactive Testing**: Tested live in browser/dev server; interactions feel fluid and ergonomic.
- [ ] **Visual Verification**: Typography, spacing, and contrast meet expectations.
- [ ] **Production Readiness**: All tests passing, clean git diff, ready to ship.

**Final Human Decision**: `[ 🚀 PENDING | 🚢 ACCEPTED_FOR_MERGE | 🛠️ FIXES_NEEDED ]`  
**Signed by Developer**: [Name / Handle]  
**Timestamp**: [YYYY-MM-DD HH:MM]
