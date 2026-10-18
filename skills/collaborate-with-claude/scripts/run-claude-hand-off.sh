#!/usr/bin/env bash
# ==============================================================================
# run-claude-hand-off.sh
# Invokes local Claude CLI with plan.md in token-conserving specialist mode.
# ==============================================================================

set -euo pipefail

PLAN_FILE="${1:-plan.md}"
MODE="headless"
PROJECT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interactive)
      MODE="interactive"
      shift
      ;;
    -p|--project)
      PROJECT_ID="$2"
      shift 2
      ;;
    -f|--file)
      PLAN_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [options] [plan-file]"
      echo ""
      echo "Options:"
      echo "  -i, --interactive    Launch interactive Claude CLI session (default: headless -p)"
      echo "  -p, --project <id>   Specify Claude Project ID / context to inject"
      echo "  -f, --file <path>    Path to plan file (default: plan.md)"
      echo "  -h, --help           Show this help message"
      exit 0
      ;;
    *)
      if [[ -f "$1" ]]; then
        PLAN_FILE="$1"
      fi
      shift
      ;;
  esac
done

# Locate Claude CLI
CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "Error: Claude CLI executable not found at '$CLAUDE_BIN' or in PATH." >&2
  echo "Please install Claude Code CLI (e.g. npm install -g @anthropic-ai/claude-code or native package)." >&2
  exit 1
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "Error: Plan file '$PLAN_FILE' not found." >&2
  echo "Please let Gemini generate '$PLAN_FILE' first before initiating hand-off." >&2
  exit 1
fi

echo "=========================================================="
echo "🚀 Initiating Claude Specialist Hand-off"
echo "📄 Plan: $PLAN_FILE"
echo "🤖 Binary: $CLAUDE_BIN"
echo "🎯 Mode: $MODE"
if [[ -n "$PROJECT_ID" ]]; then
  echo "📁 Claude Project: $PROJECT_ID"
fi
echo "=========================================================="

SYSTEM_PROMPT="You are Claude Specialist, a Senior Product Designer and Software Architect. Focus on typographic hierarchy, ergonomic UX, cognitive load reduction, and clean component structures. You are strictly forbidden from performing exploratory directory scans (e.g. find, ls -R, broad greps). Rely entirely on the pre-computed context and explicit target files in $PLAN_FILE."

if [[ -n "$PROJECT_ID" ]]; then
  SYSTEM_PROMPT="$SYSTEM_PROMPT You are targeting Claude Project: '$PROJECT_ID'."
fi

PROMPT_MSG="Read $PLAN_FILE in the current workspace and execute the specified design, architecture, and code modifications. Do not perform blind directory scans; touch only designated target files."

if [[ "$MODE" == "headless" ]]; then
  "$CLAUDE_BIN" -p "$PROMPT_MSG" \
    --append-system-prompt "$SYSTEM_PROMPT" \
    --allowed-tools "Read,Edit,Write,Bash"
else
  "$CLAUDE_BIN" \
    --append-system-prompt "$SYSTEM_PROMPT"
fi

echo ""
echo "✅ Claude Specialist execution finished. Gemini can now verify git diff and run test suites."
