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

## 6. Execution Tasks for Claude
1. [ ] Update `path/to/types.ts` with new interfaces.
2. [ ] Refactor `path/to/Component.tsx` applying typographic hierarchy and ergonomic states.
3. [ ] Ensure keyboard navigation and focus-visible rings are implemented.
4. [ ] Run targeted typecheck/lint: `npm run typecheck` or targeted unit test.

---

## 7. Verification Checklist
- [ ] Typographic scale follows consistent ratio.
- [ ] Line lengths kept within 45-75 characters.
- [ ] No exploratory commands executed.
- [ ] Clean git diff with zero unintended side effects.
