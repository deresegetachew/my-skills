#!/usr/bin/env bash
# ==============================================================================
# claude-bridge.sh
# Autonomous CLI bridge between Antigravity (Gemini) and local Claude Code.
# Enables zero-copy AI-to-AI context extraction, planning, and code review.
# ==============================================================================

set -euo pipefail

CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "Error: Claude CLI executable not found at '$CLAUDE_BIN'." >&2
  exit 1
fi

ACTION="${1:-help}"
shift || true

SYSTEM_PROMPT="You are Claude Specialist, Senior Product Designer and Software Architect collaborating with Gemini in Antigravity. When asked for plans or reviews, be concise, dense, and structured in Markdown. Rely on project memory and plan.md. Do not perform exploratory directory walks."

case "$ACTION" in
  # ----------------------------------------------------------------------------
  # 1. PULL PLAN: Extracts business analysis & technical plan directly to plan.md
  # ----------------------------------------------------------------------------
  pull-plan)
    TARGET_FILE="${1:-plan.md}"
    PROMPT="Export our current business analysis, UX design decisions, technical architecture, and pending feature roadmap in clean Markdown. Include target components, typography hierarchy, and key interfaces."
    echo "📥 Pulling project context and plans from Claude into '$TARGET_FILE'..."
    "$CLAUDE_BIN" -p "$PROMPT" \
      --append-system-prompt "$SYSTEM_PROMPT" > "$TARGET_FILE"
    echo "✅ Plan written directly to '$TARGET_FILE' (Zero manual copy needed)."
    ;;

  # ----------------------------------------------------------------------------
  # 2. ASK NEXT: Asks Claude what the immediate next implementation task is
  # ----------------------------------------------------------------------------
  ask-next)
    PROMPT="Based on our business analysis, design system, and technical plans, what is the immediate next feature or task to implement? Provide the technical requirements, expected interfaces, and acceptance criteria in Markdown so Gemini can implement or scaffold it."
    "$CLAUDE_BIN" -p "$PROMPT" \
      --append-system-prompt "$SYSTEM_PROMPT"
    ;;

  # ----------------------------------------------------------------------------
  # 3. DISCUSS / FEEDBACK: Sends Gemini's review or codebase audit to Claude
  # ----------------------------------------------------------------------------
  discuss|send-feedback)
    FEEDBACK="${1:-}"
    if [[ -f "$FEEDBACK" ]]; then
      FEEDBACK="$(cat "$FEEDBACK")"
    fi
    if [[ -z "$FEEDBACK" ]]; then
      echo "Error: No feedback provided. Pass text or file path as argument." >&2
      exit 1
    fi
    PROMPT="Gemini has audited our plan against the codebase:

$FEEDBACK

Please review this audit, adjust the technical specifications or component contracts accordingly, and specify which tasks Gemini should implement versus Claude."
    "$CLAUDE_BIN" -p "$PROMPT" \
      --append-system-prompt "$SYSTEM_PROMPT"
    ;;

  # ----------------------------------------------------------------------------
  # 4. REVIEW DIFF: Pipes git diff to Claude for Senior Architect review
  # ----------------------------------------------------------------------------
  review-diff)
    DIFF="$(git diff HEAD)"
    if [[ -z "$DIFF" ]]; then
      echo "No uncommitted changes in git diff to review."
      exit 0
    fi
    PROMPT="Review the following git diff against our architectural and design specification (in plan.md). Flag any typography violations, UX regressions, unnecessary complexity, or missing edge cases:

\`\`\`diff
$DIFF
\`\`\`"
    "$CLAUDE_BIN" -p "$PROMPT" \
      --append-system-prompt "$SYSTEM_PROMPT"
    ;;

  # ----------------------------------------------------------------------------
  # 5. EXECUTE: Tells Claude to implement its assigned tasks in plan.md
  # ----------------------------------------------------------------------------
  exec|execute)
    PLAN_FILE="${1:-plan.md}"
    if [[ ! -f "$PLAN_FILE" ]]; then
      echo "Error: Plan file '$PLAN_FILE' not found." >&2
      exit 1
    fi
    PROMPT="Read $PLAN_FILE and implement only the tasks assigned to Claude. Touch only the designated target files. Do not scan directories."
    "$CLAUDE_BIN" -p "$PROMPT" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      --allowed-tools "Read,Edit,Write,Bash"
    ;;

  *)
    echo "Usage: claude-bridge.sh <command> [arguments]"
    echo ""
    echo "Commands:"
    echo "  pull-plan [file]     Pull Claude's business analysis and architecture directly into plan.md"
    echo "  ask-next             Query Claude for the next feature/task specification"
    echo "  send-feedback <text> Send Gemini's codebase audit to Claude for plan refinement"
    echo "  review-diff          Pipe current git diff to Claude for Senior Architect review"
    echo "  exec [plan-file]     Execute tasks assigned to Claude in plan.md"
    exit 0
    ;;
esac
