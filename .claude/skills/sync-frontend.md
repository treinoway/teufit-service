# Sync Frontend

Orchestrate the full UX pipeline for frontend delivery of the latest backend feature.

## What this skill does

When invoked, you become the **orchestrator** and execute a 4-stage pipeline at the top level:

1. **Product Design** — spawn `product-design` sub-agent with the frontend brief
2. **Design Critique** — spawn `design-critic` with Stage 1 output
3. **Design Refinement** — spawn `product-design` again with design + critique
4. **Implementation** — spawn `frontend-engineer` with refined design + brief

Each stage runs sequentially. Full output is passed between stages (no summarization).

## Steps to execute

1. Read the frontend brief: `/Users/adeildoneto/Coding/treinoway/treinoway-service/.claude/frontend-brief.md`
2. If needed for ambiguity, reference backend diff: `git -C /Users/adeildoneto/Coding/treinoway/treinoway-service diff master...HEAD`
3. Execute Stages 1–4 as described in `.claude/commands/sync-frontend.md` (same prompt templates)
4. Final implementation happens in `/Users/adeildoneto/Coding/treinoway/treinoway-web`

## Agent availability check

All four agents must be accessible at top level:
- `product-design` (symlinked from treinoway-web to `~/.claude/agents/`)
- `design-critic` (symlinked from treinoway-web to `~/.claude/agents/`)
- `frontend-engineer` (user-level at `~/.claude/agents/`)

If any is missing, the pipeline cannot run — report the missing agent to the user.

## Rules

- Never skip a stage
- Never merge stages
- Pass full output between stages — do not summarize
- You coordinate; you do not design, critique, or implement yourself
