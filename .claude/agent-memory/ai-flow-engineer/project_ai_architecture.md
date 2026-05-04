---
name: AI Flow Architecture Overview
description: Architecture of the AI assistant feature in Treinoway Service — providers, service, routes, constants, and DB persistence
type: project
---

Core files:
- `src/llm/llm-provider.js` — abstract base class (chat, chatStream, buildToolResultMessages)
- `src/llm/anthropic-provider.js` — Anthropic adapter; DEFAULT_MODEL hardcoded as `claude-sonnet-4-6` (not in constants)
- `src/llm/gemini-provider.js` — Gemini adapter; DEFAULT_MODEL hardcoded as `gemini-2.5-flash` (not in constants)
- `src/llm/index.js` — factory `getLlmProvider()` reads LLM_PROVIDER env var; supports 'anthropic' | 'gemini'
- `src/constants/ai.js` — LLM_PROVIDERS, AI_TOOLS, AI_ERRORS, AI_LIMITS, AI_RETRY
- `src/services/ai-training-service.js` — main service; ~1576 lines; contains buildTrainerContext, buildSystemPrompt, TOOLS, executeTool, processAiChat, processAiChatStream, conversation CRUD
- `api/routes/ai-route.js` — 5 endpoints: POST /trainer/ai/chat, POST /trainer/ai/chat/stream (SSE), GET/DELETE /trainer/ai/conversations[/:id]
- `api/schemas/ai-route.schema.js` — Fastify JSON schema validation

Provider selection: env LLM_PROVIDER, default 'anthropic'
Model selection: env ANTHROPIC_MODEL / GEMINI_MODEL, defaults hardcoded in provider files

DB models: AiConversation, AiMessage (role: user | assistant | tool_result)
Multi-turn history: rawContent stored on assistant messages with tool calls, rebuilt via buildToolResultMessages on load

Tools (create): import_from_template, add_training_to_protocol, create_exercise_template, create_training_template, create_protocol_template
Tools (update, added 2026-04-21): update_protocol_template, update_training_template, update_exercise_template, update_protocol, update_training, update_exercise
- Update tools use PATCH semantics: Object.fromEntries(fields.filter(f => toolInput[f] !== undefined).map(...)) — only defined fields sent
- Active protocols context now enriched with trainings (take: MAX_CONTEXT_TRAININGS_PER_PROTOCOL=6) and exercises (take: MAX_CONTEXT_EXERCISES_PER_TRAINING=6)
- buildDynamicContext renders [TRAINING_REF:id] and [EXERCISE_REF:id] tags so model can identify entities for update tools
- System prompt rules renumbered: rules 5+6 are new EDICAO/REFS_DE_EDICAO; old rules 5–13 shifted to 7–15
- Tests: test/services/ai-training-service.update-tools.test.js — 26 tests, all passing

Prompt caching (added in token-optimization PR):
- `buildSystemPrompt()` now returns an ARRAY of 2 blocks instead of a plain string
  - Block 0: static rules (STATIC_SYSTEM_PROMPT module-level const) with `cache_control: { type: "ephemeral" }`
  - Block 1: dynamic context (date + trainer data) with no cache_control
- `AnthropicProvider._applyToolCache()` marks the last tool in the array with `cache_control: { type: "ephemeral" }` before passing to SDK; applied in both chat() and chatStream()
- `GeminiProvider._resolveSystemInstruction()` flattens array-of-blocks to concatenated string (Gemini has no caching equivalent)
- `LlmProvider` JSDoc updated: `system` param is `string | Array<{type, text, cache_control?}>`
- 2 cache breakpoints used (tools + system prefix); Anthropic allows max 4

Read-only tools (READ_ONLY_TOOLS Set, line ~817):
- Only `get_student_performance` currently. These bypass first-turn confirmation gate AND trigger a second LLM call after tool execution.
- Flow: first LLM call → tool_use → executeTool → save [assistant(rawContent) + tool_result] in parallel → second LLM call with tool_result in messages → save second assistant (analysis text) → return.
- Write tools still use local buildToolResultMessage response (no second LLM call).
- Fallback: if second LLM call returns empty text, `buildToolResultMessage` has a `GET_STUDENT_PERFORMANCE` case that produces a deterministic Portuguese paragraph from the snapshot.
- DB after a read-only tool turn: 3 aiMessage records (first assistant with rawContent, tool_result, second assistant with analysis). History reconstruction in loadConversationHistory handles the pair (records 1+2) then leaves record 3 as a plain assistant text turn.
- Streaming: second call uses `provider.chatStream()` so text_delta chunks are yielded to client in real time. If follow-up stream throws after partial yield, uses streamed text as-is. If no text yielded, falls back to deterministic paragraph then emits as single text_delta.

**Why:** Feature added in commit 4693263 to support natural-language training management.
**How to apply:** All AI changes must touch these files; audit security on any changes to buildSystemPrompt or executeTool. When buildSystemPrompt returns an array, downstream test assertions must use `.system[0].text` not `.system` directly for string contains checks. When adding new read-only tools, add to READ_ONLY_TOOLS set AND add a fallback case in buildToolResultMessage.
