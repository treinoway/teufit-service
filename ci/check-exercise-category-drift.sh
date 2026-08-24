#!/usr/bin/env bash
set -euo pipefail

# Guards against Prisma silently dropping the exercise_categories indexes/CHECK
# constraint that only exist as hand-added raw SQL in
# prisma/migrations/*/migration.sql (RFC 002 §5.6, addendum v3.1).
#
# `prisma migrate dev` diffs the applied migration history against
# schema.prisma. An object created by raw SQL exists only in the former, so the
# diff reads it as something to remove and emits a DropIndex/DropConstraint in
# the next generated migration. This has already happened once in this repo
# (20260617232122_library_search_indexes -> dropped 31 minutes later by
# 20260617235213_add_pagination_on_library) and is silent: no error, the app
# just starts accepting duplicate categories or a trainer_id/is_public mismatch.
#
# Run from repo root: ci/check-exercise-category-drift.sh [<base-ref>]
# Defaults to comparing against origin/master.

cd "$(dirname "$0")/.."

BASE_REF="${1:-origin/master}"

PROTECTED_OBJECTS='exercise_categories_(private_scope_name_uniq|public_name_uniq|public_ownership_chk)'

CHANGED_MIGRATIONS=$(git diff --name-only --diff-filter=ACM "${BASE_REF}..." -- 'prisma/migrations/*/migration.sql' || true)

if [ -z "${CHANGED_MIGRATIONS}" ]; then
  exit 0
fi

DRIFTED=$(echo "${CHANGED_MIGRATIONS}" \
  | xargs -r grep -lE 'Drop(Index|Constraint)' \
  | xargs -r grep -lE "${PROTECTED_OBJECTS}" || true)

if [ -n "${DRIFTED}" ]; then
  echo "Drift detectado: migration nova tenta remover um objeto protegido de exercise_categories." >&2
  echo "Arquivo(s):" >&2
  echo "${DRIFTED}" >&2
  echo "Isso é quase sempre o Prisma tentando remover um índice/constraint que ele não" >&2
  echo "vê em schema.prisma (não representável: índice parcial, CHECK condicional)." >&2
  echo "Remova o bloco DropIndex/DropConstraint da migration antes de aplicar." >&2
  echo "Ver plano de implementação, seção 1.2 e 4, e RFC 002 §5.6." >&2
  exit 1
fi

exit 0
