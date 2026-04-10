/**
 * pt-BR locale — canonical locale for Treinoway Service.
 * All keys must be present here; other locales may have missing keys
 * and will fall back to this file.
 *
 * Structure:
 *   categorical.*  — labels for DB enum values (filled per resource in follow-up PRs)
 *   errors.*       — keyed by messageCode, human-readable fallback messages
 *   validation.*   — keyed by AJV keyword; supports {field}, {min}, {max}, {allowedValues} placeholders
 */

export default {
  categorical: {
    trainingCategory: {
      strength: 'Força',
      cardio: 'Cardio',
      flexibility: 'Flexibilidade',
      rest: 'Descanso',
      functional: 'Funcional',
      mobility: 'Mobilidade',
    },
    bodySegment: {
      upper: 'Superior',
      lower: 'Inferior',
      core: 'Core',
      full_body: 'Corpo inteiro',
    },
    weekDay: {
      monday: 'Segunda-feira',
      tuesday: 'Terça-feira',
      wednesday: 'Quarta-feira',
      thursday: 'Quinta-feira',
      friday: 'Sexta-feira',
      saturday: 'Sábado',
      sunday: 'Domingo',
    },
    trainingStatus: {
      active: 'Ativo',
      completed: 'Concluído',
      archived: 'Arquivado',
    },
    protocolStatus: {},
    genderOrdination: {
      male: 'Masculino',
      female: 'Feminino',
      other: 'Outro',
    },
    trainingLevel: {
      beginner: 'Iniciante',
      intermediate: 'Intermediário',
      advanced: 'Avançado',
      athlete: 'Atleta',
    },
    protocolType: {
      strength: 'Força',
      cardio: 'Cardio',
      stretching: 'Alongamento',
      mobility: 'Mobilidade',
      activation: 'Ativação',
    },
    exerciseType: {
      strength: 'Força',
      cardio: 'Cardio',
      mobility: 'Mobilidade',
      stretching: 'Alongamento',
    },
    workoutSessionStatus: {
      in_progress: 'Em andamento',
      completed: 'Concluído',
      abandoned: 'Abandonado',
    },
    exerciseLogStatus: {
      pending: 'Pendente',
      completed: 'Concluído',
      skipped: 'Pulado',
    },
    challengeParticipantMode: {
      explicit: 'Explícito',
      filter: 'Por filtro',
      all: 'Todos',
    },
    challengeStatus: {
      scheduled: 'Agendado',
      active: 'Ativo',
      completed: 'Concluído',
      cancelled: 'Cancelado',
    },
    pointAction: {},
    anamnesisQuestionType: {
      free_text: 'Texto livre',
      dichotomous: 'Dicotômica',
      multiple_choice: 'Múltipla escolha',
      numeric: 'Numérico',
      single_choice: 'Escolha única',
      matrix: 'Matriz',
    },
    userStatus: {
      pending: 'Pendente',
      active: 'Ativo',
    },
    userGender: {
      male: 'Masculino',
      female: 'Feminino',
      other: 'Outro',
      prefer_not_to_say: 'Prefiro não informar',
    },
    userRole: {
      trainer: 'Treinador',
      admin: 'Administrador',
    },
    trainerServiceMode: {
      online: 'Online',
      in_person: 'Presencial',
      hybrid: 'Híbrido',
    },
  },

  errors: {
    // HTTP-status mapped codes (normalize-error.js)
    'request.badRequest': 'Requisição inválida. Verifique os dados e tente novamente.',
    'auth.unauthorized': 'Sessão expirada. Faça login novamente.',
    'auth.invalidCredentials': 'E-mail ou senha inválidos.',
    'auth.forbidden': 'Você não tem permissão para esta ação.',
    'resource.notFound': 'Recurso não encontrado.',
    'resource.conflict': 'Este registro já existe.',
    'request.rateLimitExceeded': 'Muitas tentativas. Aguarde um momento e tente novamente.',
    'internal.serverError': 'Erro interno do servidor. Tente novamente mais tarde.',
    'validation.failed': 'Dados inválidos. Verifique os campos e tente novamente.',

    // Database-level codes (normalize-error.js Prisma mapping)
    'database.uniqueConstraint': 'Este registro já existe.',
    'database.recordNotFound': 'Registro não encontrado.',

    // Student/trainer relationship
    'student.notFound': 'Nenhum usuário encontrado com este e-mail.',
    'student.cannotLinkSelf': 'Você não pode se vincular como seu próprio aluno.',
    'student.alreadyLinked': 'Este aluno já está vinculado à sua conta.',
    'student.notLinked': 'Este aluno não está vinculado à sua conta.',
    'student.notTrainee': 'Este aluno não pertence ao seu cadastro.',
    'trainer.notFound': 'Perfil de treinador não encontrado.',

    // Branding
    'branding.notFound': 'Personalização não encontrada. Salve as configurações primeiro.',

    // Workout session
    'workoutSession.alreadyInProgress': 'Você já possui uma sessão de treino em andamento.',

    // Anamnesis
    'anamnesis.notFound': 'Anamnese não encontrada.',
    'anamnesis.section.notFound': 'Seção não encontrada.',
    'anamnesis.question.notFound': 'Pergunta não encontrada.',
    'anamnesis.forbidden.notOwner': 'Você não tem acesso a esta anamnese.',
    'anamnesis.forbidden.general': 'Anamneses gerais não podem ser editadas.',
    'anamnesis.invalidQuestionType': 'Tipo de pergunta inválido.',
    'anamnesis.alreadyLinked': 'Esta anamnese já está vinculada a este aluno.',
    'anamnesis.hasStudentLinks': 'Esta anamnese está vinculada a alunos. Crie uma nova versão antes de editar.',
    'anamnesis.response.notFound': 'Nenhuma resposta encontrada para esta anamnese.',
    'anamnesis.notLinkedToStudent': 'Esta anamnese não está vinculada ao seu perfil.',

    // Import
    'import.primecoaching.formatChanged': 'O arquivo não corresponde ao formato esperado do PrimeCoaching. Verifique se você exportou a planilha correta.',

    // AI assistant
    'ai.trainerNotFound': 'Perfil de treinador não encontrado.',
    'ai.conversationNotFound': 'Conversa não encontrada.',
    'ai.rateLimited': 'Muitas mensagens enviadas. Aguarde um momento.',
    'ai.modelError': 'O assistente está temporariamente indisponível. Tente novamente.',
    'ai.overloaded': 'O assistente está sobrecarregado no momento. Tente novamente em instantes.',
    'ai.exerciseTemplateNotOwned': 'Modelo de exercício não pertence a você.',
    'ai.trainingTemplateNotOwned': 'Modelo de treino não pertence a você.',

    // Gamification
    'gamification.config.notFound': 'Configuração de gamificação não encontrada.',
    'gamification.action.disabled': 'Esta ação está desativada pelo treinador.',
    'gamification.ranking.insufficientStudents': 'São necessários pelo menos 3 alunos ativos (últimos 14 dias) para exibir o ranking.',
    'gamification.globalRankingRemoved': 'O ranking global foi descontinuado. Use os campeonatos.',

    // Challenge (Campeonato)
    'challenge.notFound': 'Campeonato não encontrado.',
    'challenge.invalidDates': 'Datas do campeonato inválidas. A data de início deve ser hoje ou no futuro, e a data de término deve ser igual ou após a de início.',
    'challenge.alreadyStarted': 'Este campeonato já começou e não pode ser alterado dessa forma.',
    'challenge.alreadyEnded': 'Este campeonato já terminou.',
    'challenge.alreadyCancelled': 'Este campeonato já foi cancelado.',
    'challenge.notDeletable': 'Este campeonato não pode ser excluído. Apenas campeonatos agendados podem ser removidos.',
    'challenge.forbidden.notOwner': 'Você não tem permissão para acessar este campeonato.',
    'challenge.participant.notTrainee': 'Um ou mais alunos selecionados não pertencem ao seu cadastro.',
    'challenge.participant.duplicate': 'Este aluno já participa do campeonato.',
    'challenge.participant.notFound': 'Participante não encontrado neste campeonato.',
    'challenge.filter.empty': 'Nenhum aluno atende aos critérios do filtro.',
    'challenge.durationExceeded': 'A duração do campeonato não pode ultrapassar 365 dias.',
    'challenge.notActive': 'Este campeonato não está ativo.',
  },

  validation: {
    required: 'O campo {field} é obrigatório.',
    type: 'O campo {field} tem um tipo inválido.',
    format: 'O campo {field} tem um formato inválido.',
    minLength: 'O campo {field} deve ter no mínimo {min} caracteres.',
    maxLength: 'O campo {field} deve ter no máximo {max} caracteres.',
    minimum: 'O campo {field} deve ser no mínimo {min}.',
    maximum: 'O campo {field} deve ser no máximo {max}.',
    enum: 'O valor do campo {field} é inválido. Valores aceitos: {allowedValues}.',
    pattern: 'O campo {field} não corresponde ao padrão esperado.',
    additionalProperties: 'Campos adicionais não são permitidos.',
    invalid: 'O campo {field} é inválido.',
  },
};
