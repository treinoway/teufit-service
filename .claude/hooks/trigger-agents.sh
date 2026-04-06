#!/bin/bash
# PostToolUse hook: reminds Claude to invoke downstream agents after
# touching API/service/schema files.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0

# ── Agent reminders ──────────────────────────────────────────────────

if [[ "$FILE_PATH" =~ /api/routes/ ]] || [[ "$FILE_PATH" =~ /api/schemas/ ]]; then
  echo "HOOK REMINDER: '$FILE_PATH' belongs to the API routes/schemas layer. When you have finished all related changes, proactively trigger the api-docs-sync agent to keep Postman and Swagger in sync."
elif [[ "$FILE_PATH" =~ /src/services/ ]] || [[ "$FILE_PATH" =~ /api/middleware/ ]]; then
  echo "HOOK REMINDER: '$FILE_PATH' belongs to the services/middleware layer. When you have finished all related changes, proactively trigger the test-writer agent to create or update tests."
fi

exit 0
