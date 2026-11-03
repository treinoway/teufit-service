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
    exerciseIntensity: {
      very_light: 'Muito leve',
      light: 'Leve',
      moderate: 'Moderada',
      vigorous: 'Vigorosa',
      near_maximal: 'Quase máxima',
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
      substituted: 'Substituído',
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
    anamnesisResponseStatus: {
      draft: 'Rascunho',
      awaiting_confirmation: 'Aguardando confirmação',
      submitted: 'Enviada',
    },
    anamnesisFilledBy: {
      student: 'Aluno',
      trainer: 'Professor',
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
      nutritionist: 'Nutricionista',
      admin: 'Administrador',
    },
    trainerServiceMode: {
      online: 'Online',
      in_person: 'Presencial',
      hybrid: 'Híbrido',
    },
    billingStatus: {
      overdue: 'Em atraso',
      due_soon: 'Vence em breve',
      ok: 'Em dia',
      none: 'Sem plano',
    },
    studentBlocker: {
      no_active_protocol: 'Sem rotina ativa',
      no_subscription: 'Sem plano',
      subscription_cancelled: 'Plano cancelado',
      subscription_overdue: 'Pagamento em atraso',
      blocked_on_plan: 'Bloqueado pela sua cota',
    },
    mealType: {
      breakfast: 'Café da manhã',
      lunch: 'Almoço',
      dinner: 'Jantar',
      morning_snack: 'Lanche da manhã',
      afternoon_snack: 'Lanche da tarde',
      supper: 'Ceia',
    },
    dietType: {
      standard: 'Padrão',
      low_carb: 'Low Carb',
      high_protein: 'Alta proteína',
      mediterranean: 'Mediterrânea',
      vegetarian: 'Vegetariana',
      vegan: 'Vegana',
    },
    goalType: {
      weight_loss: 'Emagrecimento',
      muscle_gain: 'Ganho de massa',
      maintenance: 'Manutenção',
      health: 'Saúde',
    },
    tmbFormula: {
      harris_benedict: 'Harris-Benedict',
      mifflin_st_jeor: 'Mifflin-St Jeor',
      fao_who: 'FAO/OMS',
      cunningham: 'Cunningham',
    },
    activityLevel: {
      sedentario: 'Sedentário',
      levemente_ativo: 'Levemente ativo',
      moderadamente_ativo: 'Moderadamente ativo',
      muito_ativo: 'Muito ativo',
      extremamente_ativo: 'Extremamente ativo',
    },
    dietProtocolStatus: {
      active: 'Ativo',
      completed: 'Concluído',
      archived: 'Arquivado',
    },
    subscriptionRecurrence: {
      monthly: 'Mensal',
      quarterly: 'Trimestral',
      semiannual: 'Semestral',
      annual: 'Anual',
    },
    subscriptionStatus: {
      active: 'Ativo',
      cancelled: 'Cancelado',
    },
    paymentStatus: {
      pending: 'Pendente',
      paid: 'Pago',
      overdue: 'Em atraso',
      cancelled: 'Anulada',
    },
    inviteStatus: {
      pending: 'Pendente',
      accepted: 'Aceito',
      revoked: 'Revogado',
      expired: 'Expirado',
    },
  },

  errors: {
    // HTTP-status mapped codes (normalize-error.js)
    'request.badRequest': 'Requisição inválida. Verifique os dados e tente novamente.',
    'auth.unauthorized': 'Sessão expirada. Faça login novamente.',
    'auth.invalidCredentials': 'E-mail ou senha inválidos.',
    'auth.forbidden': 'Você não tem permissão para esta ação.',
    'auth.apple.identityTokenRequired': 'Token de identidade da Apple ausente.',
    'auth.apple.firstLoginRequiresEmail': 'O primeiro login com a Apple precisa de e-mail. Faça login novamente.',
    'auth.apple.invalidToken': 'Token da Apple inválido.',
    'auth.apple.failed': 'Falha na autenticação. Tente novamente.',
    'auth.oauthEmailNotVerified': 'Este provedor não confirmou o seu e-mail. Verifique o e-mail na sua conta ou entre com e-mail e senha.',
    'auth.user.deleted': 'Esta conta foi excluída.',
    'account.deletion.professionalUnsupported': 'A exclusão de conta ainda não está disponível para contas de treinador ou nutricionista. Entre em contato com o suporte para encerrar uma conta profissional.',
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
    'nutritionist.notFound': 'Perfil de nutricionista não encontrado.',

    // Branding
    'branding.notFound': 'Personalização não encontrada. Salve as configurações primeiro.',

    // Workout session
    'workoutSession.alreadyInProgress': 'Você já possui uma sessão de treino em andamento.',
    'workoutSession.finalized': 'Não é possível modificar uma sessão de treino finalizada.',

    // Anamnesis
    'anamnesis.notFound': 'Anamnese não encontrada.',
    'anamnesis.section.notFound': 'Seção não encontrada.',
    'anamnesis.question.notFound': 'Pergunta não encontrada.',
    'anamnesis.forbidden.notOwner': 'Você não tem acesso a esta anamnese.',
    'anamnesis.forbidden.general': 'Anamneses gerais não podem ser editadas.',
    'anamnesis.invalidQuestionType': 'Tipo de pergunta inválido ou não suportado.',
    'anamnesis.alreadyLinked': 'Esta anamnese já está vinculada a este aluno.',
    'anamnesis.hasStudentLinks': 'Esta anamnese está vinculada a alunos. Crie uma nova versão antes de editar.',
    'anamnesis.response.notFound': 'Nenhuma resposta encontrada para esta anamnese.',
    'anamnesis.response.alreadySubmitted': 'Esta anamnese já foi enviada.',
    'anamnesis.response.submittedByStudent': 'O aluno já enviou esta anamnese.',
    'anamnesis.response.filledByAnotherTrainer': 'Esta anamnese foi preenchida por outro professor.',
    'anamnesis.response.notAwaitingConfirmation': 'Esta anamnese não está aguardando confirmação.',
    'anamnesis.notLinkedToStudent': 'Esta anamnese não está vinculada ao seu perfil.',
    'anamnesis.invalidCondition': 'Condição inválida para o tipo da pergunta pai.',
    'anamnesis.parentNotEligible': 'Apenas perguntas do tipo Sim/Não, Escolha Única ou Múltipla Escolha podem ser perguntas pai.',
    'anamnesis.parentMustBeSameSection': 'A pergunta pai deve estar na mesma seção.',
    'anamnesis.parentTypeLocked': 'O tipo da pergunta não pode ser alterado porque existem perguntas condicionais vinculadas.',
    'anamnesis.conditionReferencesRemovedOption': 'Não é possível remover uma opção referenciada por uma pergunta condicional.',
    'anamnesis.conditionalDepthExceeded': 'Perguntas condicionais não podem encadear (apenas um nível).',

    // AI assistant
    'ai.trainerNotFound': 'Perfil de treinador não encontrado.',
    'ai.conversationNotFound': 'Conversa não encontrada.',
    'ai.rateLimited': 'Muitas mensagens enviadas. Aguarde um momento.',
    'ai.modelError': 'O assistente está temporariamente indisponível. Tente novamente.',
    'ai.overloaded': 'O assistente está sobrecarregado no momento. Tente novamente em instantes.',
    'ai.exerciseTemplateNotOwned': 'Modelo de exercício não pertence a você.',
    'ai.trainingTemplateNotOwned': 'Modelo de treino não pertence a você.',
    'ai.unavailable': 'O assistente não está disponível no momento. Tente novamente mais tarde.',
    'ai.responseTooLong': 'A resposta ficou muito longa. Tente dividir o pedido em partes menores.',
    'ai.confirmationRequired': 'Confirme a ação antes de eu executá-la.',
    'ai.timeout': 'O assistente demorou demais para responder. Tente novamente ou divida o pedido em partes menores.',
    'ai.toolDisabled': 'Esta ação está temporariamente desativada. Faça a alteração manualmente.',

    // Gamification
    'gamification.config.notFound': 'Configuração de gamificação não encontrada.',
    'gamification.action.disabled': 'Esta ação está desativada pelo treinador.',
    'gamification.ranking.insufficientStudents': 'São necessários pelo menos 3 alunos ativos (últimos 14 dias) para exibir o ranking.',
    'gamification.globalRankingRemoved': 'O ranking global foi descontinuado. Use os campeonatos.',

    // Training template exercises
    'trainingTemplateExercise.notFound': 'Exercício não encontrado neste modelo de treino.',

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

    // Workouts Today
    'workoutsToday.noActiveProtocol': 'Você não tem um protocolo de treino ativo.',
    'workoutsToday.emptyProtocol': 'Seu protocolo ativo ainda não tem treinos.',

    // Diet / Nutrition
    'diet.patientNotFound': 'Paciente não encontrado.',
    'diet.patientAlreadyLinked': 'Paciente já vinculado a este nutricionista.',
    'diet.patientNotLinked': 'Paciente não vinculado a este nutricionista.',
    'diet.templateNotFound': 'Modelo de dieta não encontrado.',
    'diet.protocolNotFound': 'Protocolo de dieta não encontrado.',
    'diet.forbiddenNotTemplateOwner': 'Você não tem permissão para modificar este modelo.',
    'diet.forbiddenNotProtocolOwner': 'Você não tem permissão para modificar este protocolo.',
    'diet.forbiddenNotYourProtocol': 'Este protocolo não pertence a você.',
    'diet.mealNotFound': 'Refeição não encontrada.',
    'diet.foodItemNotFound': 'Item alimentar não encontrado.',

    // Advanced techniques
    'advancedTechnique.notFound': 'Técnica avançada não encontrada.',
    'advancedTechnique.forbidden': 'Técnicas avançadas do sistema não podem ser alteradas.',
    'advancedTechnique.invalidSelection': 'Uma ou mais técnicas avançadas selecionadas são inválidas.',

    // Dashboard
    'dashboard.invalidDateRange': 'Intervalo de datas inválido (dataInicial > dataFinal).',
    'dashboard.windowTooLarge': 'Janela de datas excede o máximo de 365 dias.',

    // Superset / bi-set
    'exercise.supersetMembershipInvalid': 'Os exercícios do bi-set devem ser contíguos na sequência do treino.',
    'exercise.supersetMinMembers': 'Um bi-set requer no mínimo 2 exercícios.',
    'exercise.supersetMaxMembers': 'Um bi-set não pode ter mais de 6 exercícios.',
    'exercise.alreadyInSuperset': 'Um ou mais exercícios já pertencem a um bi-set.',
    'exercise.supersetGroupNotFound': 'Bi-set não encontrado ou sem membros ativos.',

    // Exercise intensity
    'exercise.intensityRequiresCardio': 'A intensidade só pode ser definida para exercícios do tipo cardio.',

    // Substitute exercises
    'exercise.substituteSameTraining': 'O exercício substituto deve pertencer ao mesmo treino que o exercício principal.',
    'exercise.substituteCannotChain': 'Um exercício substituto não pode ter substitutos (sem encadeamento).',
    'exercise.substituteCannotBeInSuperset': 'Exercícios de um bi-set não podem ser usados como substitutos.',
    'exercise.substitutedAlready': 'Este exercício já é substituto de outro exercício.',
    'exercise.substituteNotFound': 'Substituto não encontrado.',
    'exercise.logAlreadySubstituted': 'Este registro de exercício já foi substituído.',
    'exercise.undoHasSets': 'Não é possível desfazer a troca: séries já foram registradas para este exercício.',
    'exercise.undoNotSubstitute': 'Este registro não é um substituto de exercício. Use este endpoint somente para desfazer trocas.',

    // Subscription plans
    'subscription.planNotFound': 'Plano de assinatura não encontrado.',
    'subscription.planArchived': 'Este plano está arquivado e não pode ser utilizado.',
    'subscription.bothDiscountsSet': 'Defina apenas um tipo de desconto: percentual ou valor fixo.',
    'subscription.discountExceedsPrice': 'O desconto não pode ser maior que o preço do plano.',
    'subscription.notFound': 'Assinatura não encontrada.',
    'subscription.cannotEditCancelled': 'Não é possível editar uma assinatura cancelada.',
    'subscription.paymentNotFound': 'Pagamento de assinatura não encontrado.',
    'subscription.paymentAlreadyPaid': 'Esta cobrança já foi paga. Para alterá-la ou anulá-la, volte-a para pendente primeiro.',
    'subscription.paymentCancelled': 'Esta cobrança foi anulada e não pode ser alterada.',
    'subscription.cancelled': 'Esta assinatura está cancelada.',
    'subscription.alreadyActive': 'Este aluno já possui uma assinatura ativa.',
    'subscription.cycleNotDue': 'O próximo ciclo ainda não está disponível para cobrança.',
    'subscription.paymentConflict': 'O pagamento foi alterado por outra operação. Atualize e tente novamente.',
    'subscription.cycleAlreadyExists': 'Este ciclo de cobrança já existe.',
    'subscription.invalidAmount': 'Valor inválido. Use até duas casas decimais e no máximo 99.999.999,99.',
    'subscription.invalidPaidAt': 'Data de pagamento inválida: não pode ser futura nem anterior a um ano antes do início da assinatura.',

    // Platform plan (SaaS gating)
    'platformPlan.studentCapExceeded': 'Você atingiu o limite de alunos do seu plano. Atualize para liberar mais espaço.',
    'platformPlan.aiNotAvailable': 'O iArnold não está disponível no seu plano. Atualize para Pro ou superior.',
    'platformPlan.aiActionsExceeded': 'Você atingiu o limite mensal de ações do iArnold para este aluno.',
    'platformPlan.brandingNotAvailable': 'Personalização de marca não está disponível no seu plano.',
    'platformPlan.championshipsNotAvailable': 'Campeonatos não estão disponíveis no seu plano.',
    'platformPlan.studentBlockedOnPlan': 'Este aluno está bloqueado pelo limite do seu plano atual. Atualize para reativar.',
    'platformPlan.upgradeRequired': 'Atualize seu plano para acessar esta funcionalidade.',
    'platformPlan.checkoutFailed': 'Não foi possível iniciar o checkout. Tente novamente.',
    'platformPlan.paymentOverdue': 'Há um pagamento em atraso. Regularize para manter o plano ativo.',
    'platformPlan.invalidTier': 'Plano inválido.',
    'platformPlan.alreadyOnTier': 'Você já está neste plano.',

    // Asaas webhook (machine-to-machine — message rarely surfaced to a human, but
    // must not read as a user auth error when someone is debugging the integration)
    'webhook.invalidSecret': 'Assinatura do webhook inválida ou ausente.',

    // Exercise last performance
    'exercise.notFound': 'Exercício não encontrado.',
    'exercise.notYours': 'Este exercício não pertence ao seu protocolo.',

    // Bulk protocol creation
    'protocol.trainingTemplateNotOwned': 'Um ou mais modelos de treino não pertencem ao seu perfil.',
    'protocol.exerciseTemplateNotOwned': 'Um ou mais modelos de exercício não pertencem ao seu perfil.',

    // Admin manager (backoffice)
    'admin.queryTimeout': 'A consulta demorou demais. Refine a busca e tente novamente.',
    'admin.userNotFound': 'Usuário não encontrado.',
    'admin.protocolNotFound': 'Rotina não encontrada.',
    // Tutorials ("Como usar")
    'tutorial.notFound': 'Tutorial não encontrado.',
    'tutorial.invalidVideoType': 'Formato de vídeo não suportado. Use MP4, WebM ou MOV.',
    'tutorial.videoTooLarge': 'O vídeo excede o tamanho máximo de 500 MB.',
    'tutorial.invalidVideoKey': 'Arquivo de vídeo inválido. Envie o vídeo novamente.',
    'tutorial.invalidOrder': 'A nova ordem dos tutoriais é inválida.',

    // Video library
    'video.notFound': 'Vídeo não encontrado.',
    'video.invalidUrl': 'URL inválida. Use um endereço http(s) válido.',
    'video.invalidCategory': 'Categoria inválida.',
    'video.invalidBodySegment': 'Segmento corporal inválido.',
    'video.titleRequired': 'O título do vídeo é obrigatório.',
    'video.tagsExceeded': 'Quantidade máxima de tags excedida.',

    // Trainer invite (closed beta)
    'invite.notFound': 'Convite não encontrado ou código inválido.',
    'invite.expired': 'Este convite expirou.',
    'invite.revoked': 'Este convite foi revogado.',
    'invite.alreadyAccepted': 'Este convite já foi utilizado.',
    'invite.emailMismatch': 'Este convite está vinculado a outro e-mail.',
    'invite.required': 'É necessário um convite de treinador para acessar esta funcionalidade durante o teste fechado.',
    'invite.alreadyActiveForEmail': 'Este e-mail já possui um convite ativo.',
    'trainerInvite.accountExists': 'Já existe uma conta para este e-mail. Entre na sua conta e resgate o convite.',

    // Student invite (trainer -> prospective student)
    'studentInvite.notFound': 'Convite não encontrado.',
    'studentInvite.notPending': 'Este convite não está mais pendente.',
    'studentInvite.resendCooldown': 'Aguarde um pouco antes de reenviar este convite.',
    'studentInvite.resendLimit': 'Você atingiu o limite de reenvios deste convite.',
    'studentInvite.alreadyPending': 'Já existe um convite pendente para este e-mail.',
    'studentInvite.dailyLimit': 'Você atingiu o limite diário de convites. Tente novamente mais tarde.',
    'studentInvite.emailSendFailed': 'Não foi possível enviar o e-mail do convite. Tente novamente.',
    'student.accountDeactivated': 'A conta deste aluno está desativada.',

    // Email verification
    'emailVerification.invalidCode': 'Código de verificação inválido.',
    'emailVerification.codeExpired': 'O código de verificação expirou. Solicite um novo.',
    'emailVerification.tooManyAttempts': 'Muitas tentativas incorretas. Solicite um novo código.',
    'emailVerification.alreadyVerified': 'Seu e-mail já foi verificado.',
    'emailVerification.resendCooldown': 'Aguarde um momento antes de solicitar um novo código.',
    'emailVerification.userNotFound': 'Usuário não encontrado.',
    'emailVerification.dailyLimit': 'Você solicitou códigos demais hoje. Tente novamente mais tarde.',
    'emailVerification.sendFailed': 'Não foi possível enviar o e-mail de verificação. Tente novamente.',

    // Password reset
    'auth.email.required': 'O e-mail é obrigatório.',
    'passwordReset.invalidCode': 'Código inválido ou expirado. Solicite um novo.',
    'passwordReset.codeRequired': 'O código de redefinição é obrigatório.',
    'passwordReset.weakPassword': 'A senha deve ter pelo menos 8 caracteres.',
    'passwordReset.passwordMismatch': 'As senhas não coincidem.',

    // Postal code lookup (legacy-coded errors from address-service)
    'legacy.POSTAL_CODE_REQUIRED': 'O CEP é obrigatório.',
    'legacy.INVALID_POSTAL_CODE_FORMAT': 'CEP inválido. O CEP deve ter 8 dígitos.',
    'legacy.POSTAL_CODE_NOT_FOUND': 'CEP não encontrado.',
    'legacy.POSTAL_CODE_API_ERROR': 'Não foi possível consultar o CEP agora. Tente novamente em instantes.',
  },

  // iArnold progress texts streamed to the client (SSE `status` events)
  ai: {
    status: {
      analyzing: 'Analisando seu pedido',
      executing: 'Executando ação',
    },
    toolStatus: {
      import_from_template: 'Importando protocolo do template',
      add_training_to_protocol: 'Adicionando treino ao protocolo',
      create_exercise_template: 'Criando exercício',
      create_training_template: 'Criando treino',
      create_protocol_template: 'Criando rotina',
      update_protocol_template: 'Editando template de protocolo',
      update_training_template: 'Editando template de treino',
      update_exercise_template: 'Editando template de exercício',
      update_protocol: 'Editando protocolo',
      update_training: 'Editando treino',
      update_exercise: 'Editando exercício',
      add_exercises_to_training: 'Adicionando exercícios ao treino',
      reorder_exercises_in_training: 'Reordenando exercícios',
      get_student_performance: 'Consultando desempenho do aluno',
      search_exercise_library: 'Consultando biblioteca de exercícios',
    },
  },

  notes: {
    autoCompleted24h: '[Treino concluído automaticamente após 24h sem atividade]',
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
