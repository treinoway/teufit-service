import { AI_TOOLS } from "../constants/ai.js";

// Tool schemas offered to the model (names, descriptions and JSON input schemas).
export const TOOLS = [
  {
    name: AI_TOOLS.IMPORT_FROM_TEMPLATE,
    description:
      'Cria um protocolo de treino para um aluno a partir de um template existente. Use quando o treinador mencionar "a partir do modelo X" ou "usando o template X".',
    input_schema: {
      type: "object",
      required: ["assigneeId", "templateId", "startDate", "expirationDate"],
      properties: {
        assigneeId: { type: "string", description: "ID do aluno (assignee)" },
        templateId: {
          type: "string",
          description: "ID do template de protocolo",
        },
        startDate: {
          type: "string",
          description: "Formato YYYY-MM-DD.",
        },
        expirationDate: {
          type: "string",
          description: "Formato YYYY-MM-DD.",
        },
        name: {
          type: "string",
          description:
            "Nome do protocolo (opcional, usa o nome do template se omitido)",
        },
      },
    },
  },
  {
    name: AI_TOOLS.CREATE_EXERCISE_TEMPLATE,
    description:
      "Cria um modelo de exercicio na biblioteca do treinador (apenas identidade: nome, tipo, video). Use quando o treinador quiser salvar um exercicio como modelo/template reutilizavel. Prescricao (series, repeticoes, carga, descanso) NAO e armazenada no template — ela e definida ao criar o treino.",
    input_schema: {
      type: "object",
      required: ["name", "type"],
      properties: {
        name: { type: "string", description: "Nome do exercicio" },
        type: {
          type: "string",
          enum: ["strength", "cardio", "mobility", "stretching"],
          description: "Tipo do exercicio",
        },
        videoUrl: { type: "string", description: "URL do video demonstrativo (opcional)" },
      },
    },
  },
  {
    name: AI_TOOLS.CREATE_TRAINING_TEMPLATE,
    description:
      "Cria um modelo de treino na biblioteca do treinador. Use quando o treinador quiser criar um treino modelo/template reutilizavel. Pode incluir exercicios novos inline (que serao criados automaticamente como templates) OU vincular exercicios existentes por ID. SEMPRE inclua TODOS os exercicios solicitados de uma vez na mesma chamada.",
    input_schema: {
      type: "object",
      required: ["name", "category"],
      properties: {
        name: { type: "string", description: "Nome do treino" },
        category: {
          type: "string",
          enum: [
            "strength",
            "cardio",
            "flexibility",
            "rest",
            "functional",
            "mobility",
          ],
          description: "Categoria do treino",
        },
        description: { type: "string", description: "Descricao do treino" },
        bodySegment: {
          type: "string",
          enum: ["upper", "lower", "core", "full_body"],
          description: "Segmento corporal",
        },
        exerciseTemplateIds: {
          type: "array",
          items: { type: "string" },
          description:
            "IDs dos modelos de exercicio existentes para vincular ao treino",
        },
        exercises: {
          type: "array",
          description:
            "Exercicios novos para criar como templates e vincular ao treino. Use este campo quando os exercicios ainda nao existem na biblioteca. IMPORTANTE: inclua aqui TODOS os exercicios que voce descreveu ao treinador na mensagem anterior. Se voce mencionou exercicios especificos por nome (ex: 'supino, crucifixo, voador'), eles OBRIGATORIAMENTE devem aparecer neste array com sets/repetitions/restInterval preenchidos. Nunca chame esta tool com array vazio se voce prometeu exercicios.",
          items: {
            type: "object",
            required: ["name", "type"],
            properties: {
              name: { type: "string", description: "Nome do exercicio" },
              type: {
                type: "string",
                enum: ["strength", "cardio", "mobility", "stretching"],
                description: "Tipo do exercicio",
              },
              prescriptionMode: {
                type: "string",
                enum: ["reps", "duration"],
                description: "'reps' (padrao) ou 'duration' para isometricos/sustentacao",
              },
              sets: { type: "integer", description: "Séries (default: 3)" },
              repetitions: {
                type: "object",
                properties: {
                  min: { type: "integer" },
                  max: { type: "integer" },
                },
                description: "Repeticoes min/max quando prescriptionMode='reps'. Omitir quando prescriptionMode='duration'.",
              },
              duration: { type: "integer", description: "Duracao em segundos quando prescriptionMode='duration'. Omitir quando prescriptionMode='reps'." },
              hasLoad: { type: "boolean", description: "true para força com peso" },
              suggestedLoad: {
                type: "number",
                description: "Carga sugerida em kg (se hasLoad=true)",
              },
              restInterval: {
                type: "integer",
                description: "Descanso em segundos (default: 60)",
              },
              notes: { type: "string", description: "Observacoes" },
            },
          },
        },
      },
    },
  },
  {
    name: AI_TOOLS.CREATE_PROTOCOL_TEMPLATE,
    description:
      "Cria um modelo de rotina (protocolo) na biblioteca do treinador. Pode incluir treinos novos inline (cada um com exercicios novos) que serao criados automaticamente como templates, OU vincular treinos existentes por ID. SEMPRE inclua TODOS os treinos e exercicios de uma vez na mesma chamada.",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Nome da rotina" },
        description: { type: "string", description: "Descricao da rotina" },
        defaultDurationWeeks: {
          type: "integer",
          description: "Duracao padrao em semanas",
        },
        genderOrdination: {
          type: "string",
          enum: ["male", "female", "other"],
          description: "Genero alvo",
        },
        trainingLevel: {
          type: "string",
          enum: ["beginner", "intermediate", "advanced", "athlete"],
          description: "Nivel de treino",
        },
        type: {
          type: "string",
          enum: ["strength", "cardio", "stretching", "mobility", "activation"],
          description: "Tipo do protocolo",
        },
        trainings: {
          type: "array",
          description:
            "Treinos da rotina. Use trainingTemplateId para vincular existente, ou name+category+exercises para criar novo inline.",
          items: {
            type: "object",
            properties: {
              trainingTemplateId: {
                type: "string",
                description:
                  "ID de um modelo de treino existente (use para vincular treinos ja criados)",
              },
              name: {
                type: "string",
                description:
                  "Nome do treino novo (obrigatorio se nao usar trainingTemplateId)",
              },
              category: {
                type: "string",
                enum: [
                  "strength",
                  "cardio",
                  "flexibility",
                  "rest",
                  "functional",
                  "mobility",
                ],
                description: "Categoria do treino novo",
              },
              bodySegment: {
                type: "string",
                enum: ["upper", "lower", "core", "full_body"],
                description: "Segmento corporal do treino novo",
              },
              description: {
                type: "string",
                description: "Descricao do treino novo",
              },
              weekDay: {
                type: "string",
                enum: [
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ],
                description: "Dia da semana",
              },
              order: { type: "integer", description: "Ordem do treino" },
              exercises: {
                type: "array",
                description:
                  "Exercicios novos para criar como templates dentro deste treino. IMPORTANTE: inclua aqui TODOS os exercicios que voce descreveu ao treinador para este treino. Se voce mencionou exercicios especificos por nome, eles OBRIGATORIAMENTE devem aparecer neste array com sets/repetitions/restInterval preenchidos. Nunca chame esta tool com array vazio se voce prometeu exercicios.",
                items: {
                  type: "object",
                  required: ["name", "type"],
                  properties: {
                    name: { type: "string" },
                    type: {
                      type: "string",
                      enum: ["strength", "cardio", "mobility", "stretching"],
                    },
                    prescriptionMode: {
                      type: "string",
                      enum: ["reps", "duration"],
                      description: "'reps' (padrao) ou 'duration' para isometricos/sustentacao",
                    },
                    sets: { type: "integer", description: "Séries (default: 3)" },
                    repetitions: {
                      type: "object",
                      properties: {
                        min: { type: "integer" },
                        max: { type: "integer" },
                      },
                      description: "Repeticoes min/max quando prescriptionMode='reps'. Omitir quando prescriptionMode='duration'.",
                    },
                    duration: { type: "integer", description: "Duracao em segundos quando prescriptionMode='duration'. Omitir quando prescriptionMode='reps'." },
                    hasLoad: { type: "boolean", description: "true para força com peso" },
                    suggestedLoad: { type: "number", description: "Carga sugerida em kg (se hasLoad=true)" },
                    restInterval: {
                      type: "integer",
                      description: "Descanso em segundos (default: 60)",
                    },
                    notes: { type: "string" },
                  },
                },
              },
              exerciseTemplateIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "IDs de modelos de exercicio existentes para vincular ao treino (alternativa ou complemento a 'exercises' inline)",
              },
            },
          },
        },
      },
    },
  },
  {
    name: AI_TOOLS.ADD_TRAINING_TO_PROTOCOL,
    description:
      'Adiciona um ou mais treinos a um protocolo existente de um aluno. Use quando o treinador quiser "adicionar um treino a rotina X".',
    input_schema: {
      type: "object",
      required: ["protocolId", "trainings"],
      properties: {
        protocolId: { type: "string", description: "ID do protocolo" },
        trainings: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "category"],
            properties: {
              name: { type: "string" },
              category: {
                type: "string",
                enum: [
                  "strength",
                  "cardio",
                  "flexibility",
                  "rest",
                  "functional",
                  "mobility",
                ],
              },
              bodySegment: {
                type: "string",
                enum: ["upper", "lower", "core", "full_body"],
              },
              description: { type: "string" },
              weekDay: {
                type: "string",
                enum: [
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ],
              },
              order: { type: "integer" },
              notes: { type: "string" },
              exercises: {
                type: "array",
                description:
                  "Exercicios novos para criar dentro deste treino. IMPORTANTE: inclua aqui TODOS os exercicios que voce descreveu ao treinador para este treino. Se voce mencionou exercicios especificos por nome, eles OBRIGATORIAMENTE devem aparecer neste array com sets/repetitions/restInterval preenchidos. Nunca chame esta tool com array vazio se voce prometeu exercicios.",
                items: {
                  type: "object",
                  required: ["name", "type"],
                  properties: {
                    name: { type: "string" },
                    type: {
                      type: "string",
                      enum: ["strength", "cardio", "mobility", "stretching"],
                    },
                    prescriptionMode: {
                      type: "string",
                      enum: ["reps", "duration"],
                      description: "'reps' (padrao) ou 'duration' para isometricos/sustentacao",
                    },
                    sets: { type: "integer", description: "Séries (default: 3)" },
                    repetitions: {
                      type: "object",
                      properties: {
                        min: { type: "integer" },
                        max: { type: "integer" },
                      },
                      description: "Repeticoes min/max quando prescriptionMode='reps'. Omitir quando prescriptionMode='duration'.",
                    },
                    duration: {
                      type: "integer",
                      description: "Duracao em segundos quando prescriptionMode='duration'. Omitir quando prescriptionMode='reps'.",
                    },
                    hasLoad: { type: "boolean", description: "true para força com peso" },
                    suggestedLoad: { type: "number", description: "Carga sugerida em kg (se hasLoad=true)" },
                    restInterval: {
                      type: "integer",
                      description: "Descanso em segundos (default: 60)",
                    },
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE,
    description:
      'Edita campos de um template de protocolo existente (nome, descricao, duracao padrao, genero, nivel, tipo). Use quando o treinador quiser modificar um template de rotina ja criado. Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['templateId'],
      properties: {
        templateId: { type: 'string', description: 'ID do template de protocolo [REF:id]' },
        name: { type: 'string', description: 'Novo nome do template' },
        description: { type: 'string', description: 'Nova descricao' },
        defaultDurationWeeks: { type: 'integer', description: 'Duracao padrao em semanas' },
        genderOrdination: { type: 'string', enum: ['male', 'female', 'other'], description: 'Genero alvo' },
        trainingLevel: { type: 'string', enum: ['beginner', 'intermediate', 'advanced', 'athlete'], description: 'Nivel de treino' },
        type: { type: 'string', enum: ['strength', 'cardio', 'stretching', 'mobility', 'activation'], description: 'Tipo do protocolo' },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_TRAINING_TEMPLATE,
    description:
      'Edita campos de um template de treino existente (nome, descricao, categoria, segmento corporal). Use quando o treinador quiser modificar um template de treino ja criado. Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['templateId'],
      properties: {
        templateId: { type: 'string', description: 'ID do template de treino [REF:id]' },
        name: { type: 'string', description: 'Novo nome' },
        description: { type: 'string', description: 'Nova descricao' },
        category: { type: 'string', enum: ['strength', 'cardio', 'flexibility', 'rest', 'functional', 'mobility'], description: 'Nova categoria' },
        bodySegment: { type: 'string', enum: ['upper', 'lower', 'core', 'full_body'], description: 'Segmento corporal' },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_EXERCISE_TEMPLATE,
    description:
      'Edita campos de identidade de um template de exercicio na biblioteca do treinador (nome, tipo, video). Prescricao nao e armazenada no template. Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['templateId'],
      properties: {
        templateId: { type: 'string', description: 'ID do template de exercicio [REF:id]' },
        name: { type: 'string', description: 'Novo nome' },
        type: { type: 'string', enum: ['strength', 'cardio', 'mobility', 'stretching'], description: 'Tipo do exercicio' },
        videoUrl: { type: 'string', description: 'URL do video demonstrativo' },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_PROTOCOL,
    description:
      'Edita campos de um protocolo ativo de um aluno (nome, descricao, status, datas). Use quando o treinador quiser modificar um protocolo ja criado. Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['protocolId'],
      properties: {
        protocolId: { type: 'string', description: 'ID do protocolo [PROTOCOL_REF:id]' },
        name: { type: 'string', description: 'Novo nome' },
        description: { type: 'string', description: 'Nova descricao' },
        status: { type: 'string', enum: ['active', 'completed', 'archived', 'paused'], description: 'Novo status' },
        startDate: { type: 'string', description: 'Nova data de inicio YYYY-MM-DD' },
        expirationDate: { type: 'string', description: 'Nova data de expiracao YYYY-MM-DD' },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_TRAINING,
    description:
      'Edita campos de um treino dentro de um protocolo ativo de aluno (nome, categoria, dia da semana, segmento, ordem, notas). Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['trainingId'],
      properties: {
        trainingId: { type: 'string', description: 'ID do treino [TRAINING_REF:id]' },
        name: { type: 'string', description: 'Novo nome' },
        description: { type: 'string', description: 'Nova descricao' },
        category: { type: 'string', enum: ['strength', 'cardio', 'flexibility', 'rest', 'functional', 'mobility'], description: 'Nova categoria' },
        bodySegment: { type: 'string', enum: ['upper', 'lower', 'core', 'full_body'], description: 'Segmento corporal' },
        weekDay: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], description: 'Dia da semana' },
        order: { type: 'integer', description: 'Ordem do treino no protocolo' },
        notes: { type: 'string', description: 'Observacoes' },
      },
    },
  },
  {
    name: AI_TOOLS.UPDATE_EXERCISE,
    description:
      'Edita campos de um exercicio dentro de um treino de protocolo ativo de aluno (series, repeticoes, carga, descanso, etc). Apenas os campos informados sao alterados.',
    input_schema: {
      type: 'object',
      required: ['exerciseId'],
      properties: {
        exerciseId: { type: 'string', description: 'ID do exercicio [EXERCISE_REF:id]' },
        name: { type: 'string', description: 'Novo nome' },
        type: { type: 'string', enum: ['strength', 'cardio', 'mobility', 'stretching'], description: 'Tipo do exercicio' },
        prescriptionMode: { type: 'string', enum: ['reps', 'duration'], description: 'Modo de prescricao: "reps" ou "duration"' },
        sets: { type: 'integer', description: 'Numero de series' },
        repetitions: { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' } }, description: 'Repeticoes min/max (quando prescriptionMode=reps)' },
        duration: { type: 'integer', description: 'Duracao em segundos (cardio/stretching)' },
        hasLoad: { type: 'boolean', description: 'true se exercicio usa carga' },
        suggestedLoad: { type: 'number', description: 'Carga sugerida em kg' },
        restInterval: { type: 'integer', description: 'Descanso em segundos' },
        notes: { type: 'string', description: 'Observacoes' },
      },
    },
  },
  // REORDER_EXERCISES_IN_TRAINING tool temporarily disabled — wrong training selection
  // and incomplete exerciseIds caused repeated failures. Executor case retained so any
  // in-flight conversation referencing it still resolves to a clean error instead of crashing.
  {
    name: AI_TOOLS.GET_STUDENT_PERFORMANCE,
    description:
      "Le desempenho recente de um aluno: contagem de sessoes por status, taxa de conclusao, " +
      "ultima sessao, e progressao de carga por exercicio. Use quando o treinador perguntar sobre " +
      "evolucao, aderencia, performance ou progressao de um aluno especifico. " +
      "FERRAMENTA DE LEITURA — execute imediatamente sem pedir confirmacao.",
    input_schema: {
      type: 'object',
      required: ['studentId'],
      properties: {
        studentId: { type: 'string', description: 'ID do aluno [ASSIGNEE_REF:id]' },
        windowDays: { type: 'integer', description: 'Janela em dias (default 90, max 365)', minimum: 1, maximum: 365 },
        includeExerciseProgression: { type: 'boolean', description: 'Incluir progressao de carga por exercicio (default true)' },
      },
    },
  },
  {
    name: AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
    description:
      'Adiciona exercicios a um treino EXISTENTE dentro de um protocolo ativo. Use quando o treinador quiser incluir exercicios em um treino que ja existe — NAO cria um treino novo. IMPORTANTE: inclua TODOS os exercicios solicitados de uma vez na mesma chamada.',
    input_schema: {
      type: 'object',
      required: ['trainingId', 'exercises'],
      properties: {
        trainingId: { type: 'string', description: 'ID do treino existente [TRAINING_REF:id]' },
        exercises: {
          type: 'array',
          description:
            'Exercicios a adicionar no treino. IMPORTANTE: inclua aqui TODOS os exercicios que voce descreveu ao treinador. Se voce mencionou exercicios especificos por nome, eles OBRIGATORIAMENTE devem aparecer neste array com sets/repetitions/restInterval preenchidos.',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string', description: 'Nome do exercicio' },
              type: {
                type: 'string',
                enum: ['strength', 'cardio', 'mobility', 'stretching'],
                description: 'Tipo do exercicio',
              },
              prescriptionMode: {
                type: 'string',
                enum: ['reps', 'duration'],
                description: "'reps' (padrao) ou 'duration' para isometricos/sustentacao",
              },
              sets: { type: 'integer', description: 'Series (default: 3)' },
              repetitions: {
                type: 'object',
                properties: { min: { type: 'integer' }, max: { type: 'integer' } },
                description: 'Repeticoes min/max quando prescriptionMode=reps. Omitir quando prescriptionMode=duration.',
              },
              duration: { type: 'integer', description: 'Duracao em segundos quando prescriptionMode=duration. Omitir quando prescriptionMode=reps.' },
              hasLoad: { type: 'boolean', description: 'true para forca com peso' },
              suggestedLoad: { type: 'number', description: 'Carga sugerida em kg (se hasLoad=true)' },
              restInterval: { type: 'integer', description: 'Descanso em segundos (default: 60)' },
              notes: { type: 'string', description: 'Observacoes sobre o exercicio' },
            },
          },
        },
      },
    },
  },
];

