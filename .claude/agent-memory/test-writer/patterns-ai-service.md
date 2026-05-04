---
name: AI service test patterns
description: Mock structure for studentDashboardService, executeTool dispatch patterns, first-turn enforcement, message save counts
type: feedback
---

## Mocking studentDashboardService in ai-training-service.test.js

Add a `vi.mock` for the student dashboard service BEFORE service imports:

```js
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
```

**Why:** ai-training-service imports `* as studentDashboardService` — mocking the module replaces all exports.

## executeTool for GET_STUDENT_PERFORMANCE

The tool dispatches to `studentDashboardService.buildAiPerformanceSnapshot(userId, studentId, { windowDays, includeExerciseProgression })` and returns `{ success: true, data: snapshot }`. AppError throws are caught and returned as `{ success: false, error, messageCode, message }`. Non-AppError throws re-propagate.

## First-turn enforcement: READ_ONLY_TOOLS

`GET_STUDENT_PERFORMANCE` is in `READ_ONLY_TOOLS`. When testing first-turn, mock only ONE `anthropicCreate` call (tool_use) — the service generates the response locally via `buildToolResultMessage` (no second LLM call). The `default` case in `buildToolResultMessage` returns `"Ação executada com sucesso!"`.

## aiMessage.create call count after tool execution (processAiChat)

When a tool executes in `processAiChat`:
1. `saveUserMessage` → 1 `aiMessage.create`
2. `saveAssistantMessage` → 1 `aiMessage.create`
3. `saveToolResultMessage` → 1 `aiMessage.create`
Total: **3 calls** (not 2).

## getConversation API limitations

`getConversation` (used by GET /trainer/ai/conversations/:id) has important constraints:
- Excludes `role: 'tool_result'` messages from the query (`where: { role: { not: 'tool_result' } }`)
- Does NOT include `rawContent` in the select
- E2E tests asserting `m.role === 'tool_result'` or `m.rawContent != null` will always fail
- Only assert on `actionsExecuted` from chat response, or message count/roles from GET conversation
