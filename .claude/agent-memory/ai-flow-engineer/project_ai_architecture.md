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

Tools: import_from_template, add_training_to_protocol, create_exercise_template, create_training_template, create_protocol_template

**Why:** Feature added in commit 4693263 to support natural-language training management.
**How to apply:** All AI changes must touch these files; audit security on any changes to buildSystemPrompt or executeTool.
