import 'dotenv/config';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { validateCondition } from '../src/constants/anamnesis.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { PrismaClient } = prismaClient;
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const CAVEIRA_TEAM_TITLE = 'Anamnese Completa';

// Conditional children: `parentOrder` is the order of the trigger question in the SAME section.
// Nested `create` cannot reference sibling ids, so links are applied in a second pass.
const whenMenstruates = {
  parentOrder: 0,
  condition: { operator: 'equals', value: 'yes' },
};

export const caveiraSections = [
  {
    title: '01 — Identificação',
    order: 0,
    questions: [
      { order: 0, text: 'Nome completo', type: 'free_text', required: true },
      { order: 1, text: 'Data de nascimento / Idade', type: 'free_text', required: true },
      { order: 2, text: 'Ocupação (descreva o tipo de trabalho: sentado, em pé, braçal, etc.)', type: 'free_text' },
      { order: 3, text: 'Quantas horas trabalha por dia em média?', type: 'numeric' },
      { order: 4, text: 'Tem parceiro(a) que também treina ou quer treinar junto?', type: 'dichotomous' },
    ],
  },
  {
    title: '02 — Objetivo e Expectativa',
    order: 1,
    questions: [
      {
        order: 0,
        text: 'Qual é o seu objetivo principal?',
        type: 'single_choice',
        required: true,
        options: [
          { text: 'Hipertrofia', order: 0 },
          { text: 'Emagrecimento', order: 1 },
          { text: 'Recomposição corporal', order: 2 },
          { text: 'Saúde', order: 3 },
          { text: 'Performance', order: 4 },
        ],
      },
      { order: 1, text: 'Descreva em detalhe como você quer estar fisicamente em 6 meses.', type: 'free_text', required: true },
      { order: 2, text: 'Em quanto tempo espera ver os primeiros resultados visíveis?', type: 'free_text' },
      { order: 3, text: 'Já tentou alcançar esse objetivo antes? O que tentou e por que não funcionou?', type: 'free_text' },
    ],
  },
  {
    title: '03 — Hábitos de Sono',
    order: 2,
    questions: [
      {
        order: 0,
        text: 'Como você classifica a qualidade do seu sono?',
        type: 'single_choice',
        options: [
          { text: 'Ótimo', order: 0 },
          { text: 'Bom', order: 1 },
          { text: 'Ruim', order: 2 },
          { text: 'Péssimo', order: 3 },
        ],
      },
      { order: 1, text: 'Quantas horas dorme por noite em média?', type: 'numeric' },
      { order: 2, text: 'Tem dificuldade para dormir ou acorda no meio da noite?', type: 'free_text' },
      { order: 3, text: 'Observações adicionais sobre o sono', type: 'free_text' },
    ],
  },
  {
    title: '04 — Estresse e Contexto de Vida',
    order: 3,
    questions: [
      { order: 0, text: 'De 0 a 10, qual o seu nível de estresse diário atual?', type: 'numeric', required: true },
      { order: 1, text: 'Tem períodos de estresse intenso (trabalho, família, financeiro)? Descreva.', type: 'free_text' },
      { order: 2, text: 'Como você lida com o estresse hoje? Tem alguma válvula de escape?', type: 'free_text' },
    ],
  },
  {
    title: '05 — Histórico Médico',
    order: 4,
    questions: [
      { order: 0, text: 'Possui plano de saúde?', type: 'dichotomous' },
      { order: 1, text: 'Realiza exames de rotina com frequência?', type: 'dichotomous' },
      { order: 2, text: 'Usou ou usa ergogênicos e/ou fármacos? Quais? Ainda usa?', type: 'free_text' },
      { order: 3, text: 'Possui alguma patologia diagnosticada?', type: 'free_text' },
      { order: 4, text: 'Faz uso de medicamentos contínuos? Quais?', type: 'free_text' },
      { order: 5, text: 'Histórico familiar relevante (doenças cardíacas, diabetes, hipertensão, etc.)', type: 'free_text' },
    ],
  },
  {
    title: '06 — Histórico de Lesões e Limitações',
    order: 5,
    questions: [
      { order: 0, text: 'Tem ou já teve alguma lesão muscular ou articular? Qual(is)?', type: 'free_text' },
      { order: 1, text: 'Qual articulação/região? Há quanto tempo ocorreu?', type: 'free_text' },
      { order: 2, text: 'Já fez tratamento? (fisioterapia, cirurgia, ortopedista) — qual foi o resultado?', type: 'free_text' },
      { order: 3, text: 'Possui laudo, exame de imagem ou relatório médico?', type: 'dichotomous' },
      { order: 4, text: 'Existe algum movimento ou posição que gera dor ou desconforto atualmente?', type: 'free_text' },
    ],
  },
  {
    title: '07 — Postura e Mobilidade',
    order: 6,
    questions: [
      { order: 0, text: 'Tem algum movimento que sente travado, limitado ou que evita fazer?', type: 'free_text' },
      { order: 1, text: 'Sente dor ou rigidez ao acordar? Em qual região?', type: 'free_text' },
      { order: 2, text: 'Tem consciência de algum desvio postural (escoliose, hiperlordose, etc.)?', type: 'free_text' },
      { order: 3, text: 'Passa muito tempo sentado ao longo do dia? Quantas horas?', type: 'free_text' },
      { order: 4, text: 'Já fez avaliação postural ou fisioterapia preventiva?', type: 'dichotomous' },
    ],
  },
  {
    title: '08 — Treino de Musculação',
    order: 7,
    questions: [
      {
        order: 0,
        text: 'Como você classifica seu nível de treinamento?',
        type: 'single_choice',
        required: true,
        options: [
          { text: 'Iniciante', order: 0 },
          { text: 'Intermediário', order: 1 },
          { text: 'Avançado', order: 2 },
        ],
      },
      { order: 1, text: 'Há quanto tempo treina musculação?', type: 'free_text' },
      { order: 2, text: 'Quantas vezes por semana treina?', type: 'numeric' },
      { order: 3, text: 'Qual o horário preferencial do treino?', type: 'free_text' },
      { order: 4, text: 'Quanto tempo tem disponível por sessão de treino?', type: 'free_text' },
      { order: 5, text: 'Tem dor ou desconforto muscular/articular durante ou após o treino?', type: 'free_text' },
      { order: 6, text: 'Atualmente controla a carga dos exercícios (registra o peso usado)?', type: 'dichotomous' },
      { order: 7, text: 'Qual método de treino está usando atualmente (ou usou por último)?', type: 'free_text' },
    ],
  },
  {
    title: '09 — Exercício Aeróbico',
    order: 8,
    questions: [
      { order: 0, text: 'Pratica ou quer praticar exercício aeróbico? (corrida, bike, funcional, etc.)', type: 'free_text' },
      { order: 1, text: 'Qual a disponibilidade para realizar (dias/semana e duração)?', type: 'free_text' },
    ],
  },
  {
    title: '10 — Ciclo Menstrual',
    description: 'Exclusivo para mulheres. Afeta performance, retenção e resultado.',
    order: 9,
    questions: [
      { order: 0, text: 'Você menstrua?', type: 'dichotomous' },
      { order: 1, text: 'Seu ciclo menstrual é regular?', type: 'dichotomous', ...whenMenstruates },
      { order: 2, text: 'Usa anticoncepcional hormonal? Qual tipo (pílula, DIU hormonal, injetável, etc.)?', type: 'free_text', ...whenMenstruates },
      { order: 3, text: 'Tem TPM intensa (inchaço, fadiga, irritabilidade, compulsão alimentar)?', type: 'free_text', ...whenMenstruates },
      { order: 4, text: 'Já percebeu variação de performance ou disposição ao longo do mês?', type: 'dichotomous', ...whenMenstruates },
      { order: 5, text: 'Está em período de pré-menopausa ou menopausa?', type: 'dichotomous', ...whenMenstruates },
    ],
  },
];

function buildQuestionCreateData(question) {
  return {
    text: question.text,
    type: question.type,
    required: question.required ?? false,
    order: question.order,
    options: question.options?.length
      ? { create: question.options.map((opt) => ({ text: opt.text, order: opt.order })) }
      : undefined,
  };
}

function buildSectionCreateData(section) {
  return {
    title: section.title,
    description: section.description ?? null,
    order: section.order,
    questions: { create: section.questions.map(buildQuestionCreateData) },
  };
}

/**
 * Same rules as `validateParentLink` (src/services/anamnesis-shared.js), minus the DB lookup:
 * the parent is resolved inside the child's own section (same-section rule), must not be a
 * child itself (single level) and its type/condition must pass `validateCondition`
 * (eligible parent type, operator/value coherent with the parent).
 */
function assertValidConditionalLink({ parentQuestion, parentDefinition, childDefinition }) {
  if (!parentQuestion) {
    throw new Error(`Seed: parent question (order ${childDefinition.parentOrder}) not found for "${childDefinition.text}"`);
  }
  if (parentDefinition.parentOrder !== undefined) {
    throw new Error(`Seed: conditional questions cannot be chained ("${childDefinition.text}")`);
  }
  validateCondition(parentQuestion, childDefinition.condition);
}

/**
 * Second pass of the seed: set `parentQuestionId` / `condition` on the conditional children.
 * Runs after the nested create because sibling ids are only known once the rows exist.
 */
async function linkConditionalQuestions(client, anamnesisId) {
  const createdSections = await client.anamnesisSection.findMany({
    where: { anamnesisId },
    include: { questions: { include: { options: true } } },
  });

  for (const sectionDefinition of caveiraSections) {
    const createdSection = createdSections.find((section) => section.order === sectionDefinition.order);
    const createdByOrder = new Map(createdSection.questions.map((question) => [question.order, question]));
    const definitionByOrder = new Map(sectionDefinition.questions.map((question) => [question.order, question]));

    for (const childDefinition of sectionDefinition.questions.filter((q) => q.parentOrder !== undefined)) {
      const parentQuestion = createdByOrder.get(childDefinition.parentOrder);
      assertValidConditionalLink({
        parentQuestion,
        parentDefinition: definitionByOrder.get(childDefinition.parentOrder),
        childDefinition,
      });

      await client.anamnesisQuestion.update({
        where: { id: createdByOrder.get(childDefinition.order).id },
        data: { parentQuestionId: parentQuestion.id, condition: childDefinition.condition },
      });
    }
  }
}

export async function seedPublicAnamnesis(client) {
  // Explicit select (same shape as the create below): reading only the columns the seed needs
  // keeps it working on a database migrated up to an older point (see default-anamnesis-migration.e2e).
  const existing = await client.anamnesis.findFirst({
    where: { title: CAVEIRA_TEAM_TITLE, isGeneral: true, deletedAt: null },
    select: { id: true, title: true },
  });

  if (existing) {
    console.log(`Seed skipped — public anamnesis "${CAVEIRA_TEAM_TITLE}" already exists (id: ${existing.id})`);
    return existing;
  }

  // One transaction: a failure in the second pass must not leave a half-built anamnesis
  // that the idempotency check above would then treat as "already seeded".
  const anamnesis = await client.$transaction(async (tx) => {
    const created = await tx.anamnesis.create({
      data: {
        trainerId: null,
        title: CAVEIRA_TEAM_TITLE,
        description: 'Diagnóstico individualizado. Sem atalhos. Sem planilha de gaveta.',
        isGeneral: true,
        sections: { create: caveiraSections.map(buildSectionCreateData) },
      },
      select: { id: true, title: true },
    });

    await linkConditionalQuestions(tx, created.id);

    return created;
  });

  console.log(`Seeded public anamnesis "${anamnesis.title}" (id: ${anamnesis.id})`);
  return anamnesis;
}

// Run as script when invoked directly (e.g. via `npx prisma db seed`).
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  seedPublicAnamnesis(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
