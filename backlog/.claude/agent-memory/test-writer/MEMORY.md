# Test Writer Memory Index

- [Unit test mock patterns](patterns-unit-mocks.md) — Prisma mock structure, beforeEach defaults, toEqual shape pinning
- [E2E test patterns](patterns-e2e.md) — app bootstrap, cleanDatabase, auth helpers, TrainerStudent setup
- [Pre-existing E2E failures](known-failures.md) — E2E files with pre-existing failures; getConversation API limitations
- [AI service test patterns](patterns-ai-service.md) — mock structure for studentDashboardService, executeTool patterns, first-turn enforcement
- [Intensity field patterns](patterns-intensity.md) — validateIntensityRequiresCardio mock patterns, dual-check in update, effectiveType/effectiveIntensity logic
- [E2E error response assertions](patterns-e2e-error-assertions.md) — never assert `body.error === 'SOME_CODE'` in E2E; assert only status code

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.
