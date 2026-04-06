# Treinoway — Sistema de Gamificação

Especificacao da Feature — v1.0 — 21 de Marco de 2026

---

## 1. Resumo

Sistema de gamificacao onde acoes do aluno (completar treino, manter streak, check-in, etc.) geram pontos configurados pelo professor. Os pontos alimentam um ranking/leaderboard entre os alunos de cada professor.

**MVP**: Pontos por treino completado + ranking semanal.

---

## 2. Schema (Prisma)

### 2.1 GamificationConfig (config por trainer)

```prisma
model GamificationConfig {
  id        String  @id @default(uuid()) @db.Uuid
  trainerId String  @unique @map("trainer_id") @db.Uuid
  enabled   Boolean @default(true)

  // Pontos por acao (null = usar default do sistema, 0 = acao desabilitada)
  ptsWorkoutCompleted   Int?  @map("pts_workout_completed")
  ptsStreak7Days        Int?  @map("pts_streak_7_days")
  ptsStreak30Days       Int?  @map("pts_streak_30_days")
  ptsDailyCheckin       Int?  @map("pts_daily_checkin")
  ptsEvolutionRecord    Int?  @map("pts_evolution_record")
  ptsWorkoutFeedback    Int?  @map("pts_workout_feedback")

  // Limites
  dailyPointsCap        Int?  @map("daily_points_cap")
  streakToleranceHours  Int   @default(24) @map("streak_tolerance_hours")

  // Ranking
  rankingMode           String  @default("weekly") @map("ranking_mode") @db.Text
  anonymousRanking      Boolean @default(false) @map("anonymous_ranking")

  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime? @updatedAt @map("updated_at") @db.Timestamptz(6)

  trainer Trainer @relation(fields: [trainerId], references: [id], onDelete: Cascade)

  @@map("gamification_configs")
}
```

### 2.2 PointTransaction (ledger imutavel)

```prisma
model PointTransaction {
  id          String   @id @default(uuid()) @db.Uuid
  studentId   String   @map("student_id") @db.Uuid
  trainerId   String   @map("trainer_id") @db.Uuid
  action      String   @db.Text
  points      Int
  referenceId String?  @map("reference_id") @db.Uuid
  reason      String?  @db.Text
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  student User    @relation(fields: [studentId], references: [id], onDelete: Cascade)
  trainer Trainer @relation(fields: [trainerId], references: [id], onDelete: Cascade)

  @@unique([action, referenceId])
  @@index([studentId, trainerId])
  @@index([trainerId, createdAt])
  @@index([studentId, createdAt])
  @@map("point_transactions")
}
```

### 2.3 PointBalance (cache materializado para ranking)

```prisma
model PointBalance {
  id          String @id @default(uuid()) @db.Uuid
  studentId   String @map("student_id") @db.Uuid
  trainerId   String @map("trainer_id") @db.Uuid
  totalPoints Int    @default(0) @map("total_points")

  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime? @updatedAt @map("updated_at") @db.Timestamptz(6)

  student User    @relation(fields: [studentId], references: [id], onDelete: Cascade)
  trainer Trainer @relation(fields: [trainerId], references: [id], onDelete: Cascade)

  @@unique([studentId, trainerId])
  @@index([trainerId, totalPoints])
  @@map("point_balances")
}
```

### 2.4 Alteracoes em models existentes

Adicionar em `User`:
```prisma
pointTransactions  PointTransaction[]
pointBalances      PointBalance[]
```

Adicionar em `Trainer`:
```prisma
gamificationConfig  GamificationConfig?
pointTransactions   PointTransaction[]
pointBalances       PointBalance[]
```

---

## 3. Constants (`src/constants/gamification.js`)

```js
export const PointAction = Object.freeze({
  WORKOUT_COMPLETED: 'workout_completed',
  STREAK_7_DAYS: 'streak_7_days',
  STREAK_30_DAYS: 'streak_30_days',
  DAILY_CHECKIN: 'daily_checkin',
  EVOLUTION_RECORD: 'evolution_record',
  WORKOUT_FEEDBACK: 'workout_feedback',
  TRAINER_BONUS: 'trainer_bonus',
});
export const pointActionValues = Object.freeze(Object.values(PointAction));

export const DEFAULT_POINT_VALUES = Object.freeze({
  [PointAction.WORKOUT_COMPLETED]: 10,
  [PointAction.STREAK_7_DAYS]: 50,
  [PointAction.STREAK_30_DAYS]: 250,
  [PointAction.DAILY_CHECKIN]: 2,
  [PointAction.EVOLUTION_RECORD]: 15,
  [PointAction.WORKOUT_FEEDBACK]: 5,
});

export const ACTION_TO_CONFIG_FIELD = Object.freeze({
  [PointAction.WORKOUT_COMPLETED]: 'ptsWorkoutCompleted',
  [PointAction.STREAK_7_DAYS]: 'ptsStreak7Days',
  [PointAction.STREAK_30_DAYS]: 'ptsStreak30Days',
  [PointAction.DAILY_CHECKIN]: 'ptsDailyCheckin',
  [PointAction.EVOLUTION_RECORD]: 'ptsEvolutionRecord',
  [PointAction.WORKOUT_FEEDBACK]: 'ptsWorkoutFeedback',
});

export const RankingMode = Object.freeze({
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  ALL_TIME: 'all_time',
});
export const rankingModeValues = Object.freeze(Object.values(RankingMode));

export const RANKING_MIN_STUDENTS = 3;
export const RANKING_INACTIVE_DAYS = 14;
export const DEFAULT_STREAK_TOLERANCE_HOURS = 24;
```

---

## 4. Services

### 4.1 `gamification-config-service.js`

- `upsertConfig({ trainerId, data })` — Upsert de GamificationConfig
- `getConfig({ trainerId })` — Config com defaults preenchidos para campos null
- `awardManualBonus({ trainerId, studentId, points, reason })` — Cria transacao `trainer_bonus`

### 4.2 `gamification-service.js`

- `resolvePointValue(config, action)` — Retorna valor efetivo. null -> default, 0 -> desabilitado
- `awardPoints({ studentId, trainerId, action, referenceId, tx })` — Core: verifica config, resolve valor, checa daily cap, cria PointTransaction, faz upsert atomico de PointBalance (increment)
- `awardWorkoutCompletionPoints({ userId, workoutSession })` — Resolve trainerId via chain `WorkoutSession -> Training -> TrainingProtocol -> Trainer`, chama `awardPoints`
- `getStudentPointHistory({ studentId, trainerId, page, limit })` — Historico paginado
- `getStudentPointSummary({ studentId, trainerId })` — Total e breakdown por action

### 4.3 `ranking-service.js`

- `getTrainerRanking({ trainerId, mode, requestingStudentId })` — Leaderboard completo
- `getStudentRankPosition({ studentId, trainerId, mode })` — Posicao individual

---

## 5. API Endpoints

### Trainer (require `Roles.TRAINER`)

| Metodo | Path | Descricao |
|--------|------|-----------|
| PUT | `/trainer/gamification/config` | Upsert config |
| GET | `/trainer/gamification/config` | Buscar config |
| POST | `/trainer/students/:studentId/bonus` | Bonus manual |
| GET | `/trainer/students/:studentId/points` | Historico do aluno |
| GET | `/trainer/ranking` | Leaderboard (`?mode=weekly`) |

### Aluno (authenticated)

| Metodo | Path | Descricao |
|--------|------|-----------|
| GET | `/my/points` | Historico de pontos (`?trainerId`) |
| GET | `/my/points/summary` | Resumo de pontos |
| GET | `/my/ranking` | Ranking do trainer (`?trainerId&mode=weekly`) |

---

## 6. Trigger de Pontos Automatico

### Workout Completion (MVP)

Hook direto em `updateSession()` no `workout-session-service.js`. Apos o update com status `completed`:

```js
if (data.status === WorkoutSessionStatus.COMPLETED) {
  awardWorkoutCompletionPoints({ userId, workoutSession: updated })
    .catch(err => fastify.log.error(err, 'Failed to award workout points'));
}
```

**Cadeia de resolucao**: `WorkoutSession.trainingId -> Training.trainingProtocolId -> TrainingProtocol.trainerId -> Trainer.id`

**Principios:**
- Fire-and-forget — falha NUNCA impede o workflow do treino
- Idempotente via `@@unique([action, referenceId])` com `referenceId = workoutSession.id`

---

## 7. Ranking — Detalhes

- **All-time**: usa `PointBalance` (ORDER BY totalPoints DESC, updatedAt ASC)
- **Weekly/Monthly**: SUM de `PointTransaction` no intervalo de datas (indices em `trainerId, createdAt`)
- **Minimo 3 alunos ativos** para exibir ranking
- **Modo anonimo**: aluno ve so sua posicao, outros aparecem como "Aluno #N"
- **Inativos 14+ dias**: removidos dos rankings semanal/mensal
- **Empate**: quem atingiu o score primeiro fica na frente

---

## 8. Fases de Implementacao

### Fase 1: Schema + Constants + Config CRUD
1. Migration Prisma (3 models + relacoes)
2. Constants file
3. `gamification-config-service.js` (upsert + get)
4. Schemas + Route (config endpoints)
5. Registrar rotas em `server.js`
6. Unit tests + E2E tests

### Fase 2: Sistema de Pontos (MVP core)
1. `gamification-service.js` (awardPoints, resolvePointValue, etc.)
2. Modificar `workout-session-service.js` (trigger no updateSession)
3. Endpoints de historico/summary do aluno
4. Unit tests + E2E tests

### Fase 3: Ranking/Leaderboard
1. `ranking-service.js`
2. Endpoints de ranking (trainer + aluno)
3. Edge cases (< 3 alunos, modo anonimo, inativos, empates)
4. Unit tests + E2E tests

### Fase 4: Bonus Manual + Polish
1. Endpoint de bonus manual
2. Postman collection
3. Testes de integracao end-to-end completos

---

## 9. Revisao Critica — Falhas e Edge Cases Identificados

### 9.1 Idempotencia via metadata JSON e ineficiente

**Problema no plano original**: O plano original usava um campo `metadata Json?` para guardar o `workoutSessionId` e checar idempotencia. Isso exigiria queries como `WHERE metadata->>'workoutSessionId' = ?`, que sao lentas sem indice GIN e frageis.

**Solucao adotada**: Campo `referenceId` com constraint `@@unique([action, referenceId])`. Idempotencia garantida pelo banco — se tentar inserir duplicata, o Prisma lanca erro que podemos capturar e ignorar silenciosamente.

### 9.2 Tiebreaker no all-time nao e preciso com updatedAt

**Problema**: O tiebreaker do spec diz "quem atingiu a pontuacao primeiro". Usando `PointBalance.updatedAt`, estamos vendo *quando o aluno ganhou pontos pela ultima vez*, nao quando atingiu aquele total especifico. Ex: aluno A chega a 100pts na segunda, ganha mais 10 na quarta (total 110). Aluno B chega a 110pts na terca. ORDER BY `updatedAt ASC` coloca B na frente (terca < quarta), mas A atingiu 110 depois de B.

**Na pratica**: como pontos so crescem e nunca expiram, o cenario problematico e raro e so ocorre quando ambos tem exatamente o mesmo total no momento da consulta. O custo de uma solucao perfeita (armazenar timestamp de cada milestone) nao justifica para o MVP. Aceitar a imprecisao e documentar.

**Alternativa futura**: Se necessario, adicionar um campo `lastPointsAt` no PointBalance que so atualiza quando o total muda de patamar, ou usar `MAX(createdAt)` da ultima transacao que igualou o score.

### 9.3 Daily cap precisa de query adicional por award

**Problema**: Se `dailyPointsCap` estiver configurado, cada chamada a `awardPoints()` precisa fazer um `SUM(points)` das transacoes do dia para aquele aluno+trainer antes de conceder. Isso adiciona latencia ao workflow de completar treino.

**Mitigacao**: Como o award e fire-and-forget, a latencia nao afeta o usuario. Mas com muitos alunos completando treinos simultaneamente, pode gerar contenção. Usar uma query otimizada com o indice `[studentId, trainerId]` + filtro por `createdAt >= inicio_do_dia`.

### 9.4 rankingMode na config: e o default ou o unico?

**Ambiguidade no spec**: O trainer "escolhe o modo de funcionamento" do ranking. Mas os endpoints tem `?mode=weekly` como query param, sugerindo que qualquer modo pode ser consultado a qualquer momento. Entao `rankingMode` na config serve pra que?

**Decisao**: `rankingMode` na config define o modo **default** exibido pro aluno (quando ele abre o ranking sem especificar modo). O aluno pode alternar entre modos na UI. O endpoint aceita `?mode=` como override.

### 9.5 Check-in diario: como triggerar?

**Problema**: O spec lista "Check-in diario" (abrir o app) como acao que vale 2pts. Mas nao existe endpoint de "abri o app" no backend. Opcoes:
1. Criar endpoint `POST /my/checkin` que o app chama ao abrir
2. Piggyback em alguma request existente (ex: GET do dashboard)

**Decisao**: Criar endpoint dedicado `POST /my/checkin`. E mais explicito, evita side-effects escondidos, e permite o app controlar quando chamar (evitando spam). O endpoint verifica se ja houve checkin hoje e ignora silenciosamente duplicatas.

**Nao e MVP** — implementar na fase apos o ranking.

### 9.6 Aluno com multiplos trainers

**Problema**: Um aluno pode ter relacao com mais de um trainer (via `TrainerStudent`). Cada trainer tem sua propria config de gamificacao e leaderboard. Isso significa:
- `PointTransaction` e `PointBalance` sao scoped por `trainerId`
- Endpoints do aluno (`/my/points`, `/my/ranking`) precisam de `?trainerId` obrigatorio, OU auto-resolver quando o aluno so tem um trainer

**Decisao**: `trainerId` e query param obrigatorio nos endpoints do aluno. Se omitido, retornar erro claro (`"trainerId is required"`). Auto-resolver e fragil quando o aluno muda de trainer.

### 9.7 Definicao de "inativo" para exclusao do ranking

**Problema**: O spec diz "inativos ha mais de 14 dias sao removidos dos rankings semanal e mensal", mas nao define inativo como. Opcoes:
1. Ultimo treino completado ha 14+ dias
2. Ultima transacao de pontos ha 14+ dias
3. Ultimo login ha 14+ dias

**Decisao**: Usar ultima transacao de pontos (`MAX(createdAt)` de `PointTransaction` para aquele aluno+trainer). E a metrica mais relevante — se o aluno nao ganha pontos, nao deveria estar no ranking de pontos. Evita dependencia de tracking de login.

### 9.8 Workout completado em protocolo sem trainer?

**Problema**: O `updateSession()` faz fire-and-forget. Se o TrainingProtocol nao tiver um trainer associado (edge case — dados orfaos), a cadeia `Training -> TrainingProtocol -> Trainer` vai falhar.

**Mitigacao**: `awardWorkoutCompletionPoints` deve ter try/catch interno e logar warning se nao encontrar trainer. Nunca lançar erro pro caller.

### 9.9 Concorrencia no PointBalance

**Problema potencial**: Dois awards simultaneos para o mesmo aluno+trainer podem causar race condition no upsert do PointBalance.

**Nao e problema**: Prisma `update` com `increment` gera SQL `UPDATE ... SET total_points = total_points + N`, que e atomico no PostgreSQL. O upsert (create or update) tambem e seguro com a `@@unique` constraint.

### 9.10 Cascade delete de Trainer apaga todo o historico

**Comportamento**: `onDelete: Cascade` em PointTransaction e PointBalance significa que deletar um Trainer apaga todo o historico de pontos dos alunos com aquele trainer.

**Aceitavel**: Se o trainer e deletado, o contexto dos pontos nao faz mais sentido. O aluno continua existindo mas seus pontos com aquele trainer desaparecem. Isso e consistente com o modelo do sistema (pontos sao scoped por trainer).

### 9.11 Performance do ranking weekly/monthly

**Problema**: Rankings semanal/mensal fazem `SUM(points) GROUP BY studentId` em PointTransaction com filtro de data. Com muitos alunos e transacoes, isso pode ficar lento.

**Mitigacao**: Os indices `[trainerId, createdAt]` e `[studentId, createdAt]` cobrem essa query. Alem disso, o ranking e filtrado por trainer, entao o conjunto e limitado (um trainer tipicamente tem dezenas de alunos, nao milhares). Se necessario no futuro, materializar rankings periodicos com cron job.

### 9.12 Streak nao esta no MVP mas precisa de tracking desde o inicio

**Consideracao**: Se o streak so comecar a ser trackeado quando implementado (fase futura), os alunos perdem o historico de streaks que ja tinham. Opcoes:
1. Implementar modelo `StudentStreak` desde o inicio (sem endpoints, so tracking)
2. Retrocomputar streaks quando a feature for implementada

**Decisao**: Nao over-engineer o MVP. Retrocomputar a partir das `WorkoutSession` com status `completed` quando a feature de streak for implementada. Os dados ja existem no banco.

---

## 10. Arquivos a Criar

| Arquivo | Proposito |
|---------|-----------|
| `prisma/migrations/YYYYMMDD_add_gamification/migration.sql` | Migration |
| `src/constants/gamification.js` | Constants |
| `src/services/gamification-service.js` | Logica core de pontos |
| `src/services/gamification-config-service.js` | CRUD de config do trainer |
| `src/services/ranking-service.js` | Computacao de leaderboard |
| `api/routes/gamification-route.js` | Endpoints |
| `api/schemas/gamification-route.schema.js` | JSON schemas Fastify |
| `test/services/gamification-service.test.js` | Unit tests |
| `test/services/gamification-config-service.test.js` | Unit tests |
| `test/services/ranking-service.test.js` | Unit tests |
| `test/e2e/gamification.e2e.test.js` | E2E tests |

## 11. Arquivos a Modificar

| Arquivo | Alteracao |
|---------|-----------|
| `prisma/schema.prisma` | 3 novos models, relacoes em User e Trainer |
| `src/services/workout-session-service.js` | Trigger de pontos no `updateSession()` |
| `api/server.js` | Registrar `gamificationRoutes` |
| `postman/Treinoway.postman_collection.json` | Novos endpoints |

---

## 12. Fora do Escopo (Nice-to-Have futuro)

- **Badges/Conquistas**: modelo `Badge` + `StudentBadge`, badges padrao + customizados pelo trainer
- **Streak tracking**: modelo `StudentStreak` com currentStreak, lastWorkoutDate, longestStreak
- **Notificacoes**: push notifications para marcos de pontos, subida no ranking, badges
- **Check-in diario**: endpoint `POST /my/checkin`
- **Evolucao / Feedback**: triggers automaticos em outros services
