/**
 * Food seed script — TBCA (primary) + TACO (fallback)
 *
 * Usage:
 *   node prisma/seeds/food-seed.js
 *
 * External data files (optional, not included in this repo):
 *   prisma/seeds/data/tbca.json  — TBCA dataset (USP/FoRC)
 *   prisma/seeds/data/taco.json  — TACO dataset (NEPA/Unicamp)
 *
 * If the data files are absent, the script falls back to the hardcoded
 * minimal sample data below (useful for local development and CI).
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { PrismaClient } = prismaClient;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Hardcoded sample data for CI / dev environments ──────────────────────────

const SAMPLE_GROUPS = [
  { name: 'Cereais e derivados', code: 'cereais' },
  { name: 'Carnes e derivados', code: 'carnes' },
  { name: 'Frutas e derivados', code: 'frutas' },
];

const SAMPLE_FOODS = [
  {
    groupCode: 'cereais',
    name: 'Arroz branco, cozido',
    source: 'taco',
    tacoId: 'TACO-001',
    energyKcal: 128,
    proteinG: 2.5,
    carbohydratesG: 28.1,
    totalFatG: 0.2,
    fiberG: 1.6,
  },
  {
    groupCode: 'cereais',
    name: 'Feijão preto, cozido',
    source: 'taco',
    tacoId: 'TACO-002',
    energyKcal: 77,
    proteinG: 4.5,
    carbohydratesG: 14.0,
    totalFatG: 0.5,
    fiberG: 8.4,
  },
  {
    groupCode: 'cereais',
    name: 'Pão de forma integral',
    source: 'taco',
    tacoId: 'TACO-003',
    energyKcal: 253,
    proteinG: 8.8,
    carbohydratesG: 44.4,
    totalFatG: 4.6,
    fiberG: 6.9,
  },
  {
    groupCode: 'carnes',
    name: 'Frango, peito, assado',
    source: 'taco',
    tacoId: 'TACO-004',
    energyKcal: 159,
    proteinG: 32.0,
    carbohydratesG: 0,
    totalFatG: 3.2,
    fiberG: 0,
  },
  {
    groupCode: 'carnes',
    name: 'Carne bovina, patinho, moído, cozido',
    source: 'taco',
    tacoId: 'TACO-005',
    energyKcal: 219,
    proteinG: 30.6,
    carbohydratesG: 0,
    totalFatG: 10.4,
    fiberG: 0,
  },
  {
    groupCode: 'carnes',
    name: 'Ovo de galinha, inteiro, frito',
    source: 'taco',
    tacoId: 'TACO-006',
    energyKcal: 209,
    proteinG: 14.1,
    carbohydratesG: 0,
    totalFatG: 16.8,
    fiberG: 0,
  },
  {
    groupCode: 'frutas',
    name: 'Banana, nanica',
    source: 'taco',
    tacoId: 'TACO-007',
    energyKcal: 92,
    proteinG: 1.4,
    carbohydratesG: 23.8,
    totalFatG: 0.1,
    fiberG: 1.9,
  },
  {
    groupCode: 'frutas',
    name: 'Maçã, com casca',
    source: 'taco',
    tacoId: 'TACO-008',
    energyKcal: 56,
    proteinG: 0.3,
    carbohydratesG: 15.2,
    totalFatG: 0.1,
    fiberG: 1.3,
  },
  {
    groupCode: 'frutas',
    name: 'Laranja, pêra',
    source: 'taco',
    tacoId: 'TACO-009',
    energyKcal: 37,
    proteinG: 0.9,
    carbohydratesG: 8.9,
    totalFatG: 0.1,
    fiberG: 0.8,
  },
  {
    groupCode: 'frutas',
    name: 'Abacate',
    source: 'taco',
    tacoId: 'TACO-010',
    energyKcal: 96,
    proteinG: 1.2,
    carbohydratesG: 6.0,
    totalFatG: 8.4,
    fiberG: 6.3,
  },
];

// ── JSON file loader (graceful on missing files) ──────────────────────────────

function loadJsonFile(filePath) {
  try {
    return require(filePath);
  } catch {
    return null;
  }
}

// ── Upsert helpers ────────────────────────────────────────────────────────────

async function upsertFoodGroup(name, code) {
  return prisma.foodGroup.upsert({
    where: { code },
    create: { name, code },
    update: { name },
  });
}

async function upsertFood(food, groupId) {
  const baseData = {
    foodGroupId: groupId,
    name: food.name,
    source: food.source || 'taco',
    energyKcal: food.energyKcal != null ? food.energyKcal : null,
    energyKj: food.energyKj != null ? food.energyKj : null,
    proteinG: food.proteinG != null ? food.proteinG : null,
    totalFatG: food.totalFatG != null ? food.totalFatG : null,
    carbohydratesG: food.carbohydratesG != null ? food.carbohydratesG : null,
    fiberG: food.fiberG != null ? food.fiberG : null,
    ashG: food.ashG != null ? food.ashG : null,
    saturatedFatG: food.saturatedFatG != null ? food.saturatedFatG : null,
    monounsaturatedFatG: food.monounsaturatedFatG != null ? food.monounsaturatedFatG : null,
    polyunsaturatedFatG: food.polyunsaturatedFatG != null ? food.polyunsaturatedFatG : null,
    transFatG: food.transFatG != null ? food.transFatG : null,
    cholesterolMg: food.cholesterolMg != null ? food.cholesterolMg : null,
    calciumMg: food.calciumMg != null ? food.calciumMg : null,
    phosphorusMg: food.phosphorusMg != null ? food.phosphorusMg : null,
    ironMg: food.ironMg != null ? food.ironMg : null,
    sodiumMg: food.sodiumMg != null ? food.sodiumMg : null,
    potassiumMg: food.potassiumMg != null ? food.potassiumMg : null,
    copperMg: food.copperMg != null ? food.copperMg : null,
    magnesiumMg: food.magnesiumMg != null ? food.magnesiumMg : null,
    manganeseMg: food.manganeseMg != null ? food.manganeseMg : null,
    zincMg: food.zincMg != null ? food.zincMg : null,
    seleniumUg: food.seleniumUg != null ? food.seleniumUg : null,
    vitaminAUgRae: food.vitaminAUgRae != null ? food.vitaminAUgRae : null,
    vitaminDUg: food.vitaminDUg != null ? food.vitaminDUg : null,
    vitaminEMg: food.vitaminEMg != null ? food.vitaminEMg : null,
    vitaminKUg: food.vitaminKUg != null ? food.vitaminKUg : null,
    thiamineMg: food.thiamineMg != null ? food.thiamineMg : null,
    riboflavinMg: food.riboflavinMg != null ? food.riboflavinMg : null,
    niacinMg: food.niacinMg != null ? food.niacinMg : null,
    vitaminB6Mg: food.vitaminB6Mg != null ? food.vitaminB6Mg : null,
    folateUg: food.folateUg != null ? food.folateUg : null,
    vitaminB12Ug: food.vitaminB12Ug != null ? food.vitaminB12Ug : null,
    vitaminCMg: food.vitaminCMg != null ? food.vitaminCMg : null,
    servingSizeG: food.servingSizeG != null ? food.servingSizeG : null,
    servingSizeDescription: food.servingSizeDescription || null,
    ediblePortionPercent: food.ediblePortionPercent != null ? food.ediblePortionPercent : null,
  };

  if (food.tbcaId) {
    return prisma.food.upsert({
      where: { tbcaId: food.tbcaId },
      create: { ...baseData, tbcaId: food.tbcaId },
      update: baseData,
    });
  }

  if (food.tacoId) {
    return prisma.food.upsert({
      where: { tacoId: food.tacoId },
      create: { ...baseData, tacoId: food.tacoId },
      update: baseData,
    });
  }

  // No external ID — create only if not exists by name+group
  const existing = await prisma.food.findFirst({
    where: { name: food.name, foodGroupId: groupId },
  });

  if (existing) return existing;

  return prisma.food.create({ data: baseData });
}

// ── Main seed function ────────────────────────────────────────────────────────

async function seedFoods() {
  console.log('Starting food seed...');

  const tbcaPath = path.join(__dirname, 'data', 'tbca.json');
  const tacoPath = path.join(__dirname, 'data', 'taco.json');

  const tbcaData = loadJsonFile(tbcaPath);
  const tacoData = loadJsonFile(tacoPath);

  if (!tbcaData && !tacoData) {
    console.log('No TBCA or TACO JSON files found. Seeding with sample data only.');
  } else {
    if (tbcaData) console.log(`TBCA data loaded: ${tbcaData.foods?.length ?? 0} foods`);
    if (tacoData) console.log(`TACO data loaded: ${tacoData.foods?.length ?? 0} foods`);
  }

  // ── Seed food groups ────────────────────────────────────────────────────────
  const groupMap = new Map();

  // Collect groups from external data first
  const allGroups = [];
  if (tbcaData?.groups) allGroups.push(...tbcaData.groups.map((g) => ({ ...g, source: 'tbca' })));
  if (tacoData?.groups) allGroups.push(...tacoData.groups.map((g) => ({ ...g, source: 'taco' })));

  for (const group of SAMPLE_GROUPS) {
    if (!allGroups.find((g) => g.code === group.code)) {
      allGroups.push(group);
    }
  }

  for (const group of allGroups) {
    const created = await upsertFoodGroup(group.name, group.code);
    groupMap.set(group.code, created.id);
  }

  console.log(`Upserted ${groupMap.size} food groups.`);

  // ── Seed TBCA foods (primary source) ───────────────────────────────────────
  let tbcaCount = 0;
  if (tbcaData?.foods) {
    for (const food of tbcaData.foods) {
      const groupId = groupMap.get(food.groupCode);
      if (!groupId) {
        console.warn(`Unknown group code "${food.groupCode}" for food "${food.name}". Skipping.`);
        continue;
      }
      await upsertFood({ ...food, source: 'tbca' }, groupId);
      tbcaCount++;
    }
    console.log(`Upserted ${tbcaCount} TBCA foods.`);
  }

  // ── Seed TACO foods (fallback for foods not in TBCA) ──────────────────────
  let tacoCount = 0;
  if (tacoData?.foods) {
    for (const food of tacoData.foods) {
      const groupId = groupMap.get(food.groupCode);
      if (!groupId) {
        console.warn(`Unknown group code "${food.groupCode}" for food "${food.name}". Skipping.`);
        continue;
      }
      await upsertFood({ ...food, source: 'taco' }, groupId);
      tacoCount++;
    }
    console.log(`Upserted ${tacoCount} TACO foods.`);
  }

  // ── Seed sample foods for dev/CI environments ──────────────────────────────
  if (!tbcaData && !tacoData) {
    let sampleCount = 0;
    for (const food of SAMPLE_FOODS) {
      const groupId = groupMap.get(food.groupCode);
      if (!groupId) continue;
      await upsertFood(food, groupId);
      sampleCount++;
    }
    console.log(`Upserted ${sampleCount} sample foods.`);
  }

  console.log('Food seed complete.');
}

seedFoods()
  .catch((error) => {
    console.error('Food seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
