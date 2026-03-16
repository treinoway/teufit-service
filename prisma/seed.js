import 'dotenv/config';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { PrismaClient } = prismaClient;
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const CAVEIRA_TEAM_TITLE = 'Anamnese Completa';

const caveiraSections = [
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
    title: '03 — Hábitos de Vida',
    order: 2,
    questions: [
      { order: 0, text: 'Possui alguma restrição alimentar?', type: 'free_text' },
      { order: 1, text: 'Qual o horário habitual das suas refeições?', type: 'free_text' },
      { order: 2, text: 'Descreva um dia típico de alimentação (do café ao jantar)', type: 'free_text' },
      { order: 3, text: 'Consome bebida alcoólica? Com qual frequência?', type: 'free_text' },
      { order: 4, text: 'É fumante ou usa cigarro eletrônico?', type: 'dichotomous' },
      { order: 5, text: 'Come fora de casa com frequência? (sim/não + quantas vezes/semana)', type: 'free_text' },
    ],
  },
  {
    title: '04 — Hábitos de Sono',
    order: 3,
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
    title: '05 — Estresse e Contexto de Vida',
    order: 4,
    questions: [
      { order: 0, text: 'De 0 a 10, qual o seu nível de estresse diário atual?', type: 'numeric', required: true },
      { order: 1, text: 'Tem períodos de estresse intenso (trabalho, família, financeiro)? Descreva.', type: 'free_text' },
      { order: 2, text: 'Como você lida com o estresse hoje? Tem alguma válvula de escape?', type: 'free_text' },
    ],
  },
  {
    title: '06 — Histórico Médico',
    order: 5,
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
    title: '07 — Histórico de Lesões e Limitações',
    order: 6,
    questions: [
      { order: 0, text: 'Tem ou já teve alguma lesão muscular ou articular? Qual(is)?', type: 'free_text' },
      { order: 1, text: 'Qual articulação/região? Há quanto tempo ocorreu?', type: 'free_text' },
      { order: 2, text: 'Já fez tratamento? (fisioterapia, cirurgia, ortopedista) — qual foi o resultado?', type: 'free_text' },
      { order: 3, text: 'Possui laudo, exame de imagem ou relatório médico?', type: 'dichotomous' },
      { order: 4, text: 'Existe algum movimento ou posição que gera dor ou desconforto atualmente?', type: 'free_text' },
    ],
  },
  {
    title: '08 — Avaliação Clínica',
    order: 7,
    questions: [
      {
        order: 0,
        text: 'Como está seu apetite?',
        type: 'single_choice',
        options: [
          { text: 'Normal', order: 0 },
          { text: 'Aumentado', order: 1 },
          { text: 'Reduzido', order: 2 },
        ],
      },
      { order: 1, text: 'Mastiga bem os alimentos?', type: 'dichotomous' },
      { order: 2, text: 'Hábito intestinal (regularidade)', type: 'free_text' },
      { order: 3, text: 'Frequência de evacuação', type: 'free_text' },
      { order: 4, text: 'Faz uso de laxante?', type: 'dichotomous' },
      { order: 5, text: 'Cor das fezes (referência de saúde digestiva)', type: 'free_text' },
      { order: 6, text: 'Frequência urinária', type: 'free_text' },
      { order: 7, text: 'Ingestão hídrica diária (em litros)', type: 'numeric' },
    ],
  },
  {
    title: '09 — Postura e Mobilidade',
    order: 8,
    questions: [
      { order: 0, text: 'Tem algum movimento que sente travado, limitado ou que evita fazer?', type: 'free_text' },
      { order: 1, text: 'Sente dor ou rigidez ao acordar? Em qual região?', type: 'free_text' },
      { order: 2, text: 'Tem consciência de algum desvio postural (escoliose, hiperlordose, etc.)?', type: 'free_text' },
      { order: 3, text: 'Passa muito tempo sentado ao longo do dia? Quantas horas?', type: 'free_text' },
      { order: 4, text: 'Já fez avaliação postural ou fisioterapia preventiva?', type: 'dichotomous' },
    ],
  },
  {
    title: '10 — Hábitos Alimentares e Suplementação',
    order: 9,
    questions: [
      { order: 0, text: 'Quais alimentos você mais gosta?', type: 'free_text' },
      { order: 1, text: 'Usa suplementos alimentares atualmente? Quais?', type: 'free_text' },
      { order: 2, text: 'Possui alergia alimentar?', type: 'free_text' },
      { order: 3, text: 'Possui intolerância alimentar (lactose, glúten, etc.)?', type: 'free_text' },
      { order: 4, text: 'Tem aversão a algum alimento (algo que se recusa a comer)?', type: 'free_text' },
    ],
  },
  {
    title: '11 — Relação com Alimentação',
    order: 10,
    questions: [
      { order: 0, text: 'Já fez dieta restritiva (low carb extremo, jejum prolongado, etc.)? Por quanto tempo?', type: 'free_text' },
      { order: 1, text: 'Tem ou já teve episódios de compulsão alimentar?', type: 'free_text' },
      { order: 2, text: 'Come por ansiedade ou estresse?', type: 'dichotomous' },
      { order: 3, text: 'Qual a sua maior dificuldade com a alimentação hoje?', type: 'free_text' },
    ],
  },
  {
    title: '12 — Treino de Musculação',
    order: 11,
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
    title: '13 — Exercício Aeróbico',
    order: 12,
    questions: [
      { order: 0, text: 'Pratica ou quer praticar exercício aeróbico? (corrida, bike, funcional, etc.)', type: 'free_text' },
      { order: 1, text: 'Qual a disponibilidade para realizar (dias/semana e duração)?', type: 'free_text' },
    ],
  },
  {
    title: '14 — Ciclo Menstrual',
    description: 'Exclusivo para mulheres. Afeta performance, retenção e resultado.',
    order: 13,
    questions: [
      { order: 0, text: 'Seu ciclo menstrual é regular?', type: 'dichotomous' },
      { order: 1, text: 'Usa anticoncepcional hormonal? Qual tipo (pílula, DIU hormonal, injetável, etc.)?', type: 'free_text' },
      { order: 2, text: 'Tem TPM intensa (inchaço, fadiga, irritabilidade, compulsão alimentar)?', type: 'free_text' },
      { order: 3, text: 'Já percebeu variação de performance ou disposição ao longo do mês?', type: 'dichotomous' },
      { order: 4, text: 'Está em período de pré-menopausa ou menopausa?', type: 'dichotomous' },
    ],
  },
];

async function main() {
  const existing = await prisma.anamnesis.findFirst({
    where: { title: CAVEIRA_TEAM_TITLE, isGeneral: true, deletedAt: null },
  });

  if (existing) {
    console.log(`Seed skipped — public anamnesis "${CAVEIRA_TEAM_TITLE}" already exists (id: ${existing.id})`);
    return;
  }

  const anamnesis = await prisma.anamnesis.create({
    data: {
      trainerId: null,
      title: CAVEIRA_TEAM_TITLE,
      description: 'Diagnóstico individualizado. Sem atalhos. Sem planilha de gaveta.',
      isGeneral: true,
      sections: {
        create: caveiraSections.map((section) => ({
          title: section.title,
          description: section.description ?? null,
          order: section.order,
          questions: {
            create: section.questions.map((q) => ({
              text: q.text,
              type: q.type,
              required: q.required ?? false,
              order: q.order,
              options: q.options?.length
                ? { create: q.options.map((opt) => ({ text: opt.text, order: opt.order })) }
                : undefined,
            })),
          },
        })),
      },
    },
    select: { id: true, title: true },
  });

  console.log(`Seeded public anamnesis "${anamnesis.title}" (id: ${anamnesis.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
