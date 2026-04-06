# Frontend Brief

!`cat /Users/adeildoneto/Coding/treinoway-service/.claude/frontend-brief.md 2>/dev/null || echo "No frontend-brief.md found. Run the backend-engineer agent on a feature first."`

# Git Diff (Backend API changes — reference only)

!`cd /Users/adeildoneto/Coding/treinoway-service && git diff master...HEAD -- api/routes/ api/schemas/ src/services/ prisma/schema.prisma 2>/dev/null || echo "No diff available."`

# Task — Orchestrate Frontend Delivery

You are now the **orchestrator** for frontend delivery of the feature described in the brief above. Execute this 4-stage pipeline at the top level, spawning specialized sub-agents via the Agent tool. **Never skip a stage. Never merge stages. Pass FULL output between stages — do not summarize.**

The final implementation happens in `/Users/adeildoneto/Coding/treinoway-web`.

---

## Stage 1 — Product Design

Invoke `product-design` agent with the frontend brief (user stories, flows, UI states, i18n keys). Do NOT include the git diff or API contract — the designer doesn't need API internals.

**Prompt template** (replace `[BRIEF]` with the full brief from above):

```
Design the UX for the following feature:

[BRIEF]

Follow your full output format:
1. Problem Understanding
2. UX Strategy
3. User Flow
4. Layout Structure (wireframe in text)
5. Components Needed
6. Interaction Details
7. Edge Cases
8. Improvements / Suggestions

Do NOT write code.
```

Wait for the full output before proceeding.

---

## Stage 2 — Design Critique

Invoke `design-critic` with Stage 1's complete output.

**Prompt template:**

```
Critically review the following UX design for Treinoway:

[STAGE 1 OUTPUT]

Use your full critique framework:
- Critical Issues
- Medium Issues
- Suggestions
- UX Score (0–10 with justification)

Be skeptical. Find real problems.
```

Wait for the full critique before proceeding.

---

## Stage 3 — Design Refinement

Invoke `product-design` again with both the original design and the critique.

**Prompt template:**

```
You previously designed the following UX:

[STAGE 1 OUTPUT]

A design critic reviewed it and found these issues:

[STAGE 2 OUTPUT]

Produce a refined final design that addresses the critical and medium issues.

Output format:
1. Final UX Strategy
2. Optimized User Flow
3. Final Layout Structure
4. Final Components List
5. Interaction Specifications
6. Summary of Changes Made

Do NOT write code.
```

Wait for the refined design before proceeding.

---

## Stage 4 — Frontend Implementation

Invoke `frontend-engineer` with the refined design (authoritative) plus the full frontend brief (needed for API contract + i18n keys).

**Prompt template:**

```
Implement the following feature in the Treinoway web frontend at /Users/adeildoneto/Coding/treinoway-web.

## Design specification (authoritative)
[STAGE 3 OUTPUT]

## Frontend brief (API contract + i18n keys)
[BRIEF]

## Requirements
- Read /Users/adeildoneto/Coding/treinoway-web/CLAUDE.md first for conventions
- Follow existing patterns (API clients, i18n, components)
- Update both pt-BR and en locale files
- Run lint and tests before reporting done
- Do NOT commit

Report back with files created/modified and any design decisions not specified in the design doc.
```

Report the final implementation summary to the user when complete.

---

## Additional context from user:
$ARGUMENTS
