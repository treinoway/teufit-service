#!/bin/bash
# PostToolUse hook: reminds Claude to invoke agents and logs API changes
# for cross-repo sync with the frontend.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

[ -z "$FILE_PATH" ] && exit 0

# Resolve project root (where .claude/ lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACTION_LOG="$PROJECT_ROOT/.claude/action-log.md"

# ── Agent reminders ──────────────────────────────────────────────────

if [[ "$FILE_PATH" =~ /api/routes/ ]] || [[ "$FILE_PATH" =~ /api/schemas/ ]]; then
  echo "HOOK REMINDER: '$FILE_PATH' belongs to the API routes/schemas layer. When you have finished all related changes, proactively trigger the api-docs-sync agent to keep Postman and Swagger in sync."
elif [[ "$FILE_PATH" =~ /src/services/ ]] || [[ "$FILE_PATH" =~ /api/middleware/ ]]; then
  echo "HOOK REMINDER: '$FILE_PATH' belongs to the services/middleware layer. When you have finished all related changes, proactively trigger the test-writer agent to create or update tests."
fi

# ── Action log for frontend sync ─────────────────────────────────────
# Logs API-relevant file changes so the frontend can read them via /sync-frontend.

if [[ "$FILE_PATH" =~ /api/routes/ ]] || [[ "$FILE_PATH" =~ /api/schemas/ ]] || [[ "$FILE_PATH" =~ /src/services/ ]] || [[ "$FILE_PATH" =~ prisma/schema.prisma ]]; then
  # Extract just the relative path from the project root
  RELATIVE_PATH="${FILE_PATH#$PROJECT_ROOT/}"

  # Initialize the log file if it doesn't exist
  if [ ! -f "$ACTION_LOG" ]; then
    BRANCH=$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || echo "unknown")
    cat > "$ACTION_LOG" << EOF
# Backend Action Log

**Branch**: $BRANCH
**Started**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

## Changed Files

EOF
  fi

  # Append the change (avoid duplicates)
  if ! grep -qF "$RELATIVE_PATH" "$ACTION_LOG" 2>/dev/null; then
    echo "- \`$RELATIVE_PATH\` ($TOOL_NAME)" >> "$ACTION_LOG"
  fi
fi

exit 0
