# Handoff Plan: [Feature or Bugfix Title]

> **Prepared by Gemini Orchestrator for Claude Specialist**  
> *Notice to Claude*: Do NOT scan directories. All target files and context are specified below.

---

## 1. Executive Objective
[Concise summary of the task, user goal, and architectural scope in 2-3 sentences.]

---

## 2. Target Files & Line Ranges
*Read and edit ONLY these files:*
- `path/to/Component.tsx` (Lines [StartLine]-[EndLine]): [Brief purpose of changes]
- `path/to/styles.css` (Lines [StartLine]-[EndLine]): [Brief purpose of changes]
- `path/to/types.ts` (Lines [StartLine]-[EndLine]): [Interface/type contract updates]

---

## 3. Design System & Typography Directives
- **Typography Hierarchy**:
  - Title/Display: [Font family, size token e.g. text-2xl/font-bold, tracking e.g. tracking-tight, line-height]
  - Body: [Font family, size e.g. text-base/leading-relaxed, max measure e.g. max-w-prose]
  - Metadata / Micro-copy: [Font size e.g. text-xs/font-medium, uppercase tracking if applicable]
- **Spacing & Layout**:
  - Grid: [4px / 8px grid tokens e.g. gap-4, p-6]
  - Alignment: [Vertical rhythm, baseline alignment]
- **Ergonomic UX & Cognitive Load**:
  - Affordances: [Button hover/active/focus-visible ring states]
  - Progressive Disclosure: [Collapsible / modal / drawer patterns to avoid clutter]
  - Empty / Error States: [Clear visual feedback with actionable retry or fallback]
- **Accessibility**:
  - WCAG Contrast target: [AA / AAA]
  - ARIA attributes: [e.g. aria-expanded, aria-controls, role="dialog"]

---

## 4. Architecture & Component Contracts
```typescript
// Required props, state, or interface definitions
export interface ComponentProps {
  // Define strict types here
}
```

- **Separation of Concerns**: [Keep presenter stateless; isolate state into custom hook or container]
- **Anti-patterns to Avoid**: [No unnecessary useEffects, no inline large styles, no untyped any]

---

## 5. Pre-computed Context & Symbol Maps
[Gemini provides pre-extracted symbols or dependencies so Claude does not need to search for them:]
- `useTheme()` is imported from `@/hooks/use-theme`
- Color tokens: `var(--bg-primary)`, `var(--text-primary)`, `var(--accent-glow)`
- Existing utility: `cn()` from `@/lib/utils`

---

## 6. Gemini Codebase Review & Grounding Audit
> *Filled by Gemini after auditing Claude's plan against the 1M+ token repository context.*
- **Feasibility & Architectural Fit**: [Analysis of how the plan aligns with existing patterns]
- **Discovered Reusable Utilities**: [Existing hooks, helpers, or API clients to leverage]
- **Potential Breaking Changes & Edge Cases**: [Schema incompatibilities, performance bottlenecks]
- **Recommended Modifications to Plan**: [Specific adjustments proposed by Gemini]

---

## 7. Dynamic Task Allocation Matrix
> *Agreed work division between Claude and Gemini/AGY.*

| Task / Deliverable | Assignee | Status | Target File(s) |
| :--- | :--- | :--- | :--- |
| Component spec & design tokens | **Claude** | Done | `src/types/`, `src/styles/` |
| Scaffolding, API routes & DB plumbing | **Gemini (AGY)** | In Progress | `src/server/`, `prisma/` |
| Ergonomic UI & interaction states | **Claude** | Pending | `src/components/` |
| Test suite & edge case mocks | **Gemini (AGY)** | Pending | `src/__tests__/` |
| Architectural code review on diff | **Claude** | Pending | `git diff` |

---

## 8. Cross-Model Review & Verification Checklist
- [ ] **Claude**: Typographic scale adheres to proportional scale (no arbitrary font sizes).
- [ ] **Claude**: Line lengths clamped to 45–75 characters (`max-w-prose`).
- [ ] **Claude**: WCAG 2.1 AA/AAA contrast and focus rings implemented.
- [ ] **Gemini**: Automated test suite passing with zero regressions.
- [ ] **Gemini**: Lint and typecheck clean (`npm run typecheck`).
- [ ] **Both**: Clean git diff with zero unintended side effects.
