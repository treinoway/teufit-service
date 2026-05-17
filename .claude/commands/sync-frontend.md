# Frontend Brief

!`cat /Users/adeildoneto/Coding/treinoway/treinoway-service/.claude/frontend-brief.md 2>/dev/null || echo "No frontend-brief.md found. Run the backend-engineer agent on a feature first."`

# Git Diff (Backend API changes — reference only)

!`git -C /Users/adeildoneto/Coding/treinoway/treinoway-service diff master...HEAD -- api/routes/ api/schemas/ src/services/ prisma/schema.prisma 2>/dev/null || echo "No diff available."`

# Design System (apply-design SKILL — canonical brand reference)

!`cat /Users/adeildoneto/Coding/treinoway/treinoway-web/.claude/skills/apply-design/SKILL.md 2>/dev/null || echo "SKILL.md missing — pipeline cannot enforce brand. Abort and warn user."`

# Existing mockups (reference for style consistency)

!`ls /Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/ 2>/dev/null || echo "(empty)"`

# Task — Orchestrate Frontend Delivery

You are now the **orchestrator** for frontend delivery of the feature described in the brief above. Execute this 5-stage pipeline at the top level, spawning specialized sub-agents via the Agent tool. **Never skip a stage. Never merge stages. Pass FULL output between stages — do not summarize.**

Final implementation happens in `/Users/adeildoneto/Coding/treinoway/treinoway-web`.

The `apply-design` SKILL block above is the **canonical brand reference** (Athletic-Tech DNA: Space Grotesk display + Inter body, `--brand-*` tokens, `--radius-brand: 8px`, UPPERCASE tracking-wide buttons, `StatDisplay`, `.theme-stadium`, kinetic motion). Every stage receives it inline. Legacy aliases (`--color-*`, `--md-primary`, `--shadow-sm`, `--radius-sm`, `--radius-md`, `--ease-out`) are forbidden in new code; pipeline rejects any output that introduces them.

**Mockup slug:** derive a short kebab-case slug from the feature name (e.g. `protocol-edit`, `student-cockpit-v2`). Pass the same slug to every stage. Mockup file path is always `/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<slug>.html`.

---

## Stage 1 — Product Design + HTML Mockup

Invoke `product-design` agent with the frontend brief and the full SKILL block. Designer produces both the structured spec AND a static HTML mockup file.

**Prompt template** (replace placeholders):

```
Design the UX for the following feature AND produce a static HTML mockup as a visual artifact.

[BRIEF]

## Brand & Design System (authoritative — Athletic-Tech DNA)

[SKILL]

## Deliverables

### 1. Structured spec (in your reply)
Follow your full output format:
1. Problem Understanding
2. UX Strategy
3. User Flow
4. Layout Structure (token-named)
5. Components Needed (catalog names from SKILL §3)
6. Interaction Details (motion tokens explicit)
7. Edge Cases
8. Improvements / Suggestions
9. Brand Application Notes

### 2. HTML mockup file
Write a self-contained mockup at:
`/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`

Slug for this feature: `<SLUG>`

Mockup rules (also in your agent definition):
- Link `<link rel="stylesheet" href="../src/index.css">` so live tokens render
- **Desktop-first mockup**: base container 1280–1440px. Trainer reviews big decisions on desktop. React implementation stays mobile-first responsive (per SKILL §1), but the visual artifact targets desktop. Optional smaller mobile snapshot at the bottom of the file.
- Canonical `--brand-*` tokens only. ZERO legacy aliases.
- Athletic-Tech expression visible: Space Grotesk titles, Inter body, UPPERCASE tracking-wide buttons, `StatDisplay`-style numbers (Space Grotesk + tabular-nums) for any metric, `.theme-stadium` wrapper where execution/stat-heavy
- Lucide icons (inline SVG or CDN)
- Show 2+ states on same page, labeled: default + (empty / loading / error / expanded — pick what matters)
- No React, no Vite, no JS logic beyond trivial toggle. No API calls.

Report the mockup file path back in your reply.

Do NOT write any React/JSX/production code.
```

Wait for both the spec and the file path before proceeding. Verify the file exists with a `Bash` `ls` before moving to Stage 2.

---

## Stage 2 — Design Critique (on the HTML mockup)

Invoke `design-critic` with Stage 1's spec output AND the mockup path. Critic Reads the HTML file directly and critiques the rendered design.

**Prompt template:**

```
Critically review the following UX design + HTML mockup for Treinoway.

## Spec from product-design

[STAGE 1 SPEC OUTPUT]

## Mockup file (READ THIS FIRST — it is the source of truth for visual decisions)

`/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`

## Brand & Design System (authoritative — Athletic-Tech DNA)

[SKILL]

Use your full critique framework PLUS Brand Fidelity. Quote actual class names and tokens from the HTML file to back every flag. Brand drift is a critical issue.

Output:
- Critical Issues
- Medium Issues
- Suggestions
- Brand Fidelity (quote HTML evidence)
- UX Score (0–10 with justification)

Be skeptical. Find real problems. Reject anything that smells legacy.
```

Wait for full critique before proceeding.

---

## Stage 3 — Design Refinement (spec + updated mockup)

Invoke `product-design` again with original spec, critique, and SKILL. Designer edits the SAME mockup file in place and outputs a refined spec.

**Prompt template:**

```
You previously designed the following UX and produced an HTML mockup:

[STAGE 1 SPEC OUTPUT]

Mockup file: `/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`

A design critic reviewed it and found these issues:

[STAGE 2 OUTPUT]

## Brand & Design System (authoritative — Athletic-Tech DNA)

[SKILL]

## Deliverables

### 1. Refined spec
Output:
1. Final UX Strategy
2. Optimized User Flow
3. Final Layout Structure (token-named)
4. Final Components List (catalog names from SKILL §3)
5. Interaction Specifications (motion tokens explicit)
6. Brand Application Notes
7. Summary of Changes Made (cite which critique items resolved)

### 2. Updated mockup
EDIT the same file in place: `/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`
Address every Critical and Medium issue from the critique. Address every Brand Fidelity flag. Same file rules as Stage 1.

Do NOT write React/JSX.
```

Wait for refined spec + confirmation file was updated.

---

## Stage 4 — APPROVAL GATE (HARD STOP)

After Stage 3 completes, **the pipeline halts**. Do NOT spawn the frontend-engineer.

Report to the user with EXACTLY this structure:

```
## Mockup ready for review

**Feature:** <feature name>
**Slug:** <slug>
**Mockup:** `/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`

Open it in a browser:
  open /Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html

(Or `cd treinoway-web && npx serve .` and visit `http://localhost:3000/mockups/<SLUG>.html` to load live tokens from `src/index.css`.)

### Critique → resolution summary
[bullet list: each critical/medium critique item → how Stage 3 resolved it]

### Awaiting your approval
Reply with one of:
- `approved` / `aprovado` — proceed to React implementation (Stage 5)
- specific feedback — pipeline loops back to Stage 3 with your notes
```

Then STOP. Do not invoke frontend-engineer. Wait for the next user message.

When the user replies:
- If the reply is approval (`approved`, `aprovado`, `ok`, `prossiga`, etc.) → proceed to Stage 5
- If the reply contains feedback → re-invoke `product-design` with [Stage 3 OUTPUT] + the user's notes + SKILL, same prompt as Stage 3 but feedback replaces the critique. Loop back to Stage 4 with the new mockup.
- If ambiguous → ask the user to clarify approve vs revise.

---

## Stage 5 — Frontend Implementation

Only run after explicit user approval. Invoke `frontend-engineer` with the refined spec (authoritative), the full frontend brief, the SKILL block inline, AND the approved mockup file path.

**Prompt template:**

```
Implement the following feature in the Treinoway web frontend at /Users/adeildoneto/Coding/treinoway/treinoway-web.

The user has APPROVED the visual mockup. Use it as the authoritative visual reference. The React implementation should match the mockup pixel-faithfully in layout, tokens, typography, and brand expression.

## Approved mockup (visual source of truth — READ this file first)
`/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<SLUG>.html`

## Design specification (authoritative for behavior)
[STAGE 3 OUTPUT]

## Frontend brief (API contract + i18n keys)
[BRIEF]

## Design System — apply-design SKILL (authoritative; YOU CANNOT invoke /apply-design as a subagent, so this inline copy is the only source)

[SKILL]

## Requirements
- Read /Users/adeildoneto/Coding/treinoway/treinoway-web/CLAUDE.md first for conventions
- Read the approved mockup file before writing any JSX — it is the visual contract
- Treat the SKILL block as canonical: tokens-only, Athletic-Tech expression where mockup specifies it
- Zero legacy aliases in new code (`--color-*`, `--md-primary`, `--shadow-sm`, `--radius-sm`, `--radius-md`, `--ease-out`)
- Zero inline `style={{}}` for fixed values (only dynamic/computed allowed)
- Reuse catalog components/classes from SKILL §3 — check `src/index.css` before adding new CSS
- Performance numbers use `StatDisplay` + `--font-family-stat` + `tabular-nums`
- Execution/dark-stat surfaces wrap in `.theme-stadium`
- Buttons/segmented toggles: UPPERCASE label, `--tracking-wide`, weight 600, 13px
- Update both pt-BR and en locale files
- Run lint and tests before reporting done
- Do NOT commit
- Do NOT delete the mockup file — it stays as visual reference

Final report must include the apply-design review checklist (each item ✓): tokens-only, no legacy aliases, no inline style for fixed values, mobile-first, accessibility, reused existing classes, brand expression matches mockup, mockup file untouched.
```

Report the final implementation summary to the user when complete.

---

## Additional context from user:
$ARGUMENTS
