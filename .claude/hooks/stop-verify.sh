#!/usr/bin/env bash
# Stop hook: gate the end of a turn on lint + affected unit tests, and flag
# changed source files that have no accompanying test change.
#
# Runs eslint on changed JS files and `vitest related` on them (unit only — e2e
# needs Docker and is too slow for a per-turn gate). On failure it exits 2,
# which blocks Claude from stopping and feeds the output back so it fixes it.
#
# Loop guards:
#   - stop_hook_active=true (Claude is already continuing because of this hook)
#     → let it stop, so a fix it cannot make never traps it.
#   - a fingerprint of the working tree is stored per worktree; if nothing
#     changed since the last check (pass or fail), skip. Q&A turns cost nothing
#     and a known failure is reported once, not on every turn.
#
# Also invoked by the treinoway/ root dispatcher (verify-dispatch.sh) with
# CLAUDE_PROJECT_DIR pointing at this repo.
set -uo pipefail

input=$(cat)
[[ "$(jq -r '.stop_hook_active // false' <<< "$input")" == "true" ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

paths=(api src test prisma/seeds)

changed=$(
  {
    git diff --name-only HEAD -- "${paths[@]}"
    git ls-files --others --exclude-standard -- "${paths[@]}"
  } | grep -E '\.(js|cjs|mjs)$' | sort -u | while IFS= read -r f; do
    [[ -f "$f" ]] && printf '%s\n' "$f"
  done
)
[[ -z "$changed" ]] && exit 0

state_file=$(git rev-parse --git-path claude-stop-verify.sha)
fingerprint=$(
  {
    git diff HEAD -- "${paths[@]}"
    printf '%s\n' "$changed" | while IFS= read -r f; do cat "$f"; done
  } | shasum | cut -d' ' -f1
)
[[ -f "$state_file" && "$(cat "$state_file")" == "$fingerprint" ]] && exit 0
printf '%s' "$fingerprint" > "$state_file"

files=()
changed_tests=()
while IFS= read -r f; do
  files+=("$f")
  [[ "$f" == test/*.test.js ]] && changed_tests+=("$f")
done <<< "$changed"

failed=0
report=""

# Fixing a frozen violation leaves an unused entry in eslint-suppressions.json,
# which fails lint; prune it so the ratchet only ever moves down.
lint_out=$(npx --no-install eslint "${files[@]}" 2>&1)
lint_status=$?
if grep -q 'do not occur anymore' <<< "$lint_out"; then
  npx --no-install eslint --prune-suppressions "${files[@]}" >/dev/null 2>&1
  lint_out=$(npx --no-install eslint "${files[@]}" 2>&1)
  lint_status=$?
fi
if [[ $lint_status -ne 0 ]]; then
  failed=1
  report+=$'## eslint\n'"$(tail -n 40 <<< "$lint_out")"$'\n\n'
fi

test_out=$(npx --no-install vitest related "${files[@]}" --run --passWithNoTests 2>&1)
if [[ $? -ne 0 ]]; then
  failed=1
  report+=$'## vitest related (unit)\n'"$(sed $'s/\x1b\\[[0-9;]*m//g' <<< "$test_out" | tail -n 60)"$'\n\n'
fi

# Source files changed with no test change: neither the mirrored test file
# (src/foo/bar.js → test/foo/bar.test.js) nor any changed test mentioning the
# module name. Routes are usually covered by e2e, so only the mention check.
untested=()
for f in "${files[@]}"; do
  mirror=""
  case "$f" in
    src/i18n/*|src/constants/*|src/config/*|src/db.js|*/index.js) continue ;;
    src/*) mirror="test/${f#src/}"; mirror="${mirror%.*}.test.js" ;;
    api/routes/*) ;;
    *) continue ;;
  esac
  [[ -n "$mirror" ]] && grep -qxF "$mirror" <<< "$changed" && continue
  name=$(basename "${f%.*}")
  if [[ ${#changed_tests[@]} -gt 0 ]] && grep -qF "$name" "${changed_tests[@]}"; then
    continue
  fi
  untested+=("$f")
done

if [[ ${#untested[@]} -gt 0 ]]; then
  failed=1
  report+=$'## changed without test changes\n'
  report+="$(printf -- '- %s\n' "${untested[@]}")"$'\n'
  report+=$'Add or update tests for these (delegate to the test-writer agent), or tell the user why no test change is needed.\n'
fi

# Deviations from the code conventions must be visible to the user: list each
# new `deviation:` note or eslint-disable added in this tree, once.
alerted_file=$(git rev-parse --git-path claude-deviations-alerted)
deviations=$(
  {
    git diff -U0 HEAD -- "${paths[@]}" | awk '/^\+\+\+ b\//{f=substr($0,7)} /^\+[^+]/{print f": "substr($0,2)}'
    git ls-files --others --exclude-standard -- "${paths[@]}" | while IFS= read -r f; do
      [[ -f "$f" ]] && sed "s|^|$f: |" "$f"
    done
  } | grep -E '(//|/\*).*(deviation:|eslint-disable)' | grep -v '^test/eslint-rules/' \
    | sed -E 's/:[[:space:]]+/: /' | sort -u
)
new_deviations=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  grep -qxF "$line" "$alerted_file" 2>/dev/null && continue
  new_deviations+="$line"$'\n'
  printf '%s\n' "$line" >> "$alerted_file"
done <<< "$deviations"

if [[ -n "$new_deviations" ]]; then
  failed=1
  report+=$'## new deviations from the code conventions\n'"$new_deviations"
  report+=$'List each of these to the user in your final message, with its reason. A blanket `eslint-disable` (no rule list) or one without ` -- <reason>` must be replaced.\n'
fi

[[ $failed -eq 0 ]] && exit 0

{
  printf '[stop-verify] Verification failed for files changed in this working tree. '
  printf 'Fix it before finishing, or explain to the user why it cannot be fixed now.\n\n'
  printf '%s' "$report"
} >&2
exit 2
