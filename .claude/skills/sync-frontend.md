# Sync Frontend

Orchestrate the full UX pipeline for frontend delivery of the latest backend feature.

## What this skill does

When invoked, you become the **orchestrator** and execute a 5-stage pipeline at the top level:

1. **Product Design + HTML Mockup** — spawn `product-design`. Outputs structured spec AND writes a static HTML mockup at `treinoway-web/mockups/<slug>.html`.
2. **Design Critique** — spawn `design-critic` with the spec + mockup path. Critic Reads the HTML directly.
3. **Design Refinement** — spawn `product-design` again with critique. Edits the SAME mockup in place.
4. **Approval Gate (HARD STOP)** — report mockup path + critique-resolution summary to the user. Wait for explicit approval (`approved`/`aprovado`) or feedback. On feedback, loop back to Stage 3. Never invoke frontend-engineer without approval.
5. **Implementation** — spawn `frontend-engineer` with refined spec + approved mockup as visual source of truth + brief + SKILL.

Each stage runs sequentially. Full output passed between stages (no summarization).

## Steps to execute

1. Read the frontend brief: `/Users/adeildoneto/Coding/treinoway/treinoway-service/.claude/frontend-brief.md`
2. Read the apply-design SKILL: `/Users/adeildoneto/Coding/treinoway/treinoway-web/.claude/skills/apply-design/SKILL.md` — canonical brand reference, MUST be passed inline to every stage (subagents have no `Skill` tool)
3. Derive a short kebab-case slug for the feature. Mockup path = `/Users/adeildoneto/Coding/treinoway/treinoway-web/mockups/<slug>.html`
4. If needed for ambiguity, reference backend diff: `git -C /Users/adeildoneto/Coding/treinoway/treinoway-service diff master...HEAD`
5. Execute Stages 1–5 as described in `.claude/commands/sync-frontend.md`. Every stage prompt MUST include the full SKILL.md content inline.
6. **Stage 4 is a hard stop.** Do not proceed to Stage 5 without explicit user approval. On user feedback, loop back to Stage 3.
7. Final implementation happens in `/Users/adeildoneto/Coding/treinoway/treinoway-web`. Mockup file is NOT deleted — stays as visual reference.

## Agent availability check

All three agents must be accessible at top level:
- `product-design` (symlinked from treinoway-web to `~/.claude/agents/`)
- `design-critic` (symlinked from treinoway-web to `~/.claude/agents/`)
- `frontend-engineer` (user-level at `~/.claude/agents/`)

If any is missing, the pipeline cannot run — report the missing agent to the user.

## Rules

- Never skip a stage
- Never merge stages
- Pass full output between stages — do not summarize
- Stage 4 is non-bypassable — explicit user approval required before Stage 5
- The mockup file is the visual contract — Stage 5 implementation must match it
- You coordinate; you do not design, critique, or implement yourself
