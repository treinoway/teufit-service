# Frontend Brief — Exercise templates são identity-only

**Backend branch**: staging · **Generated**: 2026-06-10

## O que mudou (backend)
O `ExerciseTemplate` da **biblioteca** agora guarda só **identidade do exercício**: `name`, `type`, `videoUrl`, `isPublic`. Todos os campos de prescrição (`sets`, `repetitions`, `duration`, `prescriptionMode`, `hasLoad`, `suggestedLoad`, `restInterval`, `notes`, `intensity`) foram **removidos** do modelo da biblioteca.

A prescrição ("como o exercício é feito") só existe **dentro de um template de treino** (no junction `TrainingTemplateExerciseTemplate`) e no `Exercise` real. Motivo de produto: importar um exercício da biblioteca **não** deve trazer preset — séries/reps variam por treino.

## Impacto no frontend (treinoway-web)

### 1. Formulário de Exercise Template (biblioteca)
- **Remover** todos os inputs de prescrição do form de criar/editar exercise template: sets, repetições, duração, modo de prescrição, carga (hasLoad/suggestedLoad), descanso, notes, intensidade.
- Manter só: **nome**, **tipo**, **vídeo (videoUrl)**, e o toggle **público (isPublic)**.
- Endpoints (rotas inalteradas): `POST/PATCH /trainer/exercise-templates`. Bodies agora aceitam **apenas** `{ name, type, videoUrl, isPublic }`. Campos extras de prescrição são ignorados (stripped) pelo servidor — não envie.
- Resposta desses endpoints não traz mais campos de prescrição.

### 2. Montagem de template de treino — adicionar exercício da biblioteca
- Ao adicionar um exercício existente da biblioteca a um training template (`POST /trainer/training-templates/:templateId/exercises/from-template`), o endpoint **agora aceita** prescrição no body: `prescriptionMode`, `sets`, `repetitions {min,max}`, `duration`, `hasLoad`, `suggestedLoad`, `restInterval`, `notes`, `intensity` (+ `order`, `supersetGroupId`, `supersetOrder`).
- UX: ao puxar um exercício da biblioteca, os campos de prescrição vêm **vazios** (não mais pré-preenchidos do template). O treinador preenche a prescrição para aquele treino. Mostrar os inputs de prescrição nesse passo.
- O exercício ad-hoc (`POST /trainer/training-templates/:templateId/exercises`) continua aceitando prescrição; agora também aceita `intensity`.

### 3. Telas que exibiam prescrição "vinda da biblioteca"
- Se alguma tela mostrava sets/reps/etc. a partir do objeto `exerciseTemplate` (biblioteca) — ex.: card de biblioteca, preview de import — remover. Esses dados não existem mais lá.
- Dentro do training template, a prescrição vem do **junction** (`trainingTemplateExerciseTemplates[]`), que mantém todos os campos. O objeto aninhado `exerciseTemplate` agora é identity-only.

## Não mudou
- `Exercise` real (dentro de um treino) e o junction do training template continuam com prescrição completa.
- Fluxo de aplicar protocolo/treino ao aluno (`importFromTemplate`) — inalterado; a prescrição vem do junction.
