# AI Flow — Auditoria e Melhorias

Auditoria realizada em 2026-03-31 pelo `ai-flow-engineer` agent.

---

## Achados Criticos

### CRIT-1 — IDOR via `exerciseTemplateIds` e `trainingTemplateId` sem validacao de ownership
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** No tool `CREATE_TRAINING_TEMPLATE`, o array `exerciseTemplateIds` vindo do LLM era usado sem verificar que os IDs pertencem ao trainer autenticado. Mesmo problema em `CREATE_PROTOCOL_TEMPLATE` com `trainingTemplateId`.
- **Impacto:** Trainer A poderia vincular exercise/training templates do Trainer B.
- **Status:** Corrigido
- **Correcao:** Validacao de ownership adicionada com query `WHERE trainerId = trainer.id` antes de usar os IDs. Novos error constants: `EXERCISE_TEMPLATE_NOT_OWNED`, `TRAINING_TEMPLATE_NOT_OWNED`.

### CRIT-2 — Prompt injection via mensagem do usuario sem delimitacao
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** Mensagem do usuario interpolada diretamente no array de mensagens sem delimitadores explicitos.
- **Impacto:** Atacante poderia tentar induzir o LLM a executar tools com IDs escolhidos.
- **Status:** Corrigido
- **Correcao:** Mensagem wrappada com `<user_input>` tags em `processAiChat` e `processAiChatStream`. Nova regra no system prompt instruindo o modelo a tratar conteudo dessas tags como input nao confiavel.

---

## Achados de Alta Severidade

### HIGH-1 — `logAiAction` loga `toolInput` completo com PII
- **Arquivo:** `src/services/ai-training-service.js` (funcao `logAiAction`)
- **Problema:** `toolInput` pode conter assigneeId, nomes de alunos e dados pessoais. Em producao, isso vai para log aggregators.
- **Impacto:** Exposicao de PII em logs.
- **Status:** Corrigido
- **Correcao:** Adicionada funcao `sanitizeToolInput()` que redact campos PII (`assigneeId`, `name`, `notes`, `description`, `email`) com `[REDACTED]` e colapsa arrays em `[array:N]`. `logAiAction` agora usa o input sanitizado.

### HIGH-2 — `DEFAULT_MODEL` hardcoded nos providers, sem model tiering
- **Arquivos:** `src/llm/anthropic-provider.js`
- **Problema:** Model names hardcoded fora de `src/constants/ai.js`. Todas as chamadas usam o mesmo modelo independente da complexidade.
- **Impacto:** Viola padrao de constants do projeto. Custo desnecessario para tarefas simples.
- **Status:** Corrigido (constants centralizados, model tiering pendente)
- **Correcao:** Adicionado `AI_MODELS` em `src/constants/ai.js` com `ANTHROPIC`. O provider importa de la.

### HIGH-3 — Rate limit do AI route pode nao estar usando keyGenerator por userId
- **Arquivo:** `api/routes/ai-route.js`
- **Problema:** O rate limit configurado no route usa o comportamento padrao (key por IP), nao por userId.
- **Impacto:** Usuarios atras de NAT/proxy compartilhado podem conflitar. Usuarios com multiplos IPs podem contornar o limite.
- **Status:** Corrigido
- **Correcao:** Adicionado `keyGenerator: (request) => \`ai:${request.user.id}\`` nos rate limit configs dos endpoints `/chat` e `/chat/stream`.

### HIGH-4 — Heartbeat SSE nao cancelado em disconnect do cliente
- **Arquivo:** `api/routes/ai-route.js`
- **Problema:** Se o cliente fechar a conexao durante o stream, o heartbeat e a chamada ao LLM continuam ativos.
- **Impacto:** Resource leak — timers e tokens desperdicados. Erros de `write on closed socket`.
- **Status:** Corrigido
- **Correcao:** Adicionado listener `request.raw.on('close', ...)` que seta flag `clientDisconnected`, limpa heartbeat e quebra o loop do stream.

### HIGH-5 — `rawContent` expoe internals do provider via GET conversation
- **Arquivo:** `api/routes/ai-route.js`, `api/schemas/ai-route.schema.js`
- **Problema:** Endpoint retorna `rawContent` com formato nativo do provider (tool_use, tool_result, function calls), expondo nomes de tools internas.
- **Impacto:** Information leakage — cliente pode inspecionar estrutura das tool calls.
- **Status:** Corrigido
- **Correcao:** `getConversation` agora usa `select` explicito excluindo `rawContent`. Propriedade removida do schema de resposta.

---

## Achados de Media Severidade

### MED-1 — `MAX_MESSAGE_LENGTH` diverge entre constants e schema
- **Arquivos:** `src/constants/ai.js` (5000), `api/schemas/ai-route.schema.js` (1000)
- **Status:** Pendente
- **Correcao sugerida:** Decidir o valor correto e usar o constant no schema.

### MED-2 — Duplicacao entre `processAiChat` e `processAiChatStream`
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** Mesmo loop agentic duplicado. Logica de retry ja divergiu entre as versoes.
- **Status:** Pendente
- **Correcao sugerida:** Extrair o loop agentic para uma funcao compartilhada com callback de output (sync vs stream).

### MED-3 — Error codes `legacy.*` fora do padrao
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** messageCodes como `legacy.TRAINER_PROFILE_MISSING` inconsistentes com o padrao `ai.*`.
- **Status:** Pendente
- **Correcao sugerida:** Migrar para `AI_ERRORS` constants com messageCodes padronizados.

### MED-4 — Temperatura nao configurada (default 1.0)
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** Chamadas ao LLM nao especificam temperatura. Default do Anthropic e 1.0, inadequado para acoes deterministicas.
- **Status:** Pendente
- **Correcao sugerida:** Configurar `temperature: 0` para acoes de criacao/edicao. Adicionar constant `AI_TEMPERATURE`.

### MED-5 — `setupConversation` sem testes unitarios isolados
- **Status:** Pendente
- **Correcao sugerida:** Adicionar testes cobrindo edge cases (falha no saveUserMessage apos createConversation).

### MED-6 — Output do LLM salvo sem sanitizacao
- **Arquivo:** `src/services/ai-training-service.js`
- **Problema:** Texto gerado pelo LLM salvo diretamente no DB sem sanitizacao.
- **Status:** Pendente
- **Correcao sugerida:** Sanitizar output antes de persistir (strip HTML/scripts no minimo).

---

## Achados de Baixa Severidade

### LOW-1 — `processAiChatStream` sem cobertura de testes
- **Status:** Pendente

### LOW-2 — Postman collection com apenas 2 de 5 endpoints do AI
- **Status:** Pendente

### LOW-3 — `getLlmProvider` cria nova instancia a cada request
- **Status:** Pendente

### LOW-4 — Sem timeout explicito nas chamadas ao LLM
- **Status:** Pendente

### LOW-5 — `checkEnforcementBlocked` com logica ambigua para multiplas tool calls
- **Status:** Pendente
