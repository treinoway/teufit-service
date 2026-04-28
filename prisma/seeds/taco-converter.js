/**
 * TACO Converter — Taco-4a-Edicao.xlsx
 *
 * Converts the official TACO 4th-edition Excel (NEPA/Unicamp) to
 * prisma/seeds/data/taco.json for use by food-seed.js.
 *
 * Sheets used:
 *   CMVCol taco3  — macros + micronutrients (main)
 *   AGtaco3       — fatty acids (saturated, mono, poly, trans)
 *
 * Usage:
 *   node prisma/seeds/taco-converter.js [path/to/Taco-4a-Edicao.xlsx]
 *
 * Default input path: ./Taco-4a-Edicao.xlsx (repo root)
 * Output: prisma/seeds/data/taco.json
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INPUT = path.resolve(__dirname, '../../Taco-4a-Edicao.xlsx');
const OUTPUT_FILE = path.join(__dirname, 'data', 'taco.json');

// ── CMVCol taco3 — column indices ─────────────────────────────────────────────
// Row 3 is the first data row; rows 0-2 are split headers.
// Col 13 is a duplicate food-number column (layout artifact) — ignored.
const MAIN_COLS = {
  num:          0,
  name:         1,
  // umidade:    2  — not in schema
  energyKcal:   3,
  energyKj:     4,
  proteinG:     5,
  totalFatG:    6,
  cholesterolMg:7,
  carbohydratesG:8,
  fiberG:       9,
  ashG:         10,
  calciumMg:    11,
  magnesiumMg:  12,
  // col 13 = duplicate num — skip
  manganeseMg:  14,
  phosphorusMg: 15,
  ironMg:       16,
  sodiumMg:     17,
  potassiumMg:  18,
  copperMg:     19,
  zincMg:       20,
  // retinol:   21  — raw retinol, prefer RAE
  // RE:        22  — retinol equivalent, prefer RAE
  vitaminAUgRae:23,
  thiamineMg:   24,
  riboflavinMg: 25,
  vitaminB6Mg:  26,
  niacinMg:     27,
  vitaminCMg:   28,
};

// ── AGtaco3 — column indices ───────────────────────────────────────────────────
// Col 12 is a duplicate food-number column — ignored.
// Trans fat = 18:1t (col 23) + 18:2t (col 24)
const AG_COLS = {
  num:               0,
  saturatedFatG:     2,
  monounsaturatedFatG:3,
  polyunsaturatedFatG:4,
  transFat18_1:      23,  // 18:1t
  transFat18_2:      24,  // 18:2t
};

// ── Group names that are really repeat header rows — must be ignored ──────────
const HEADER_ROW_MARKERS = new Set(['número do', 'alimento', 'legenda', '*', '†']);

// ── Group code mapping (matches TBCA scraper codes for shared groups) ─────────
const GROUP_CODE_MAP = {
  'cereais e derivados':                    'cereais',
  'verduras, hortaliças e derivados':       'hortalicas',
  'frutas e derivados':                     'frutas',
  'gorduras e óleos':                       'gorduras',
  'pescados e frutos do mar':               'pescados',
  'carnes e derivados':                     'carnes',
  'leite e derivados':                      'leite',
  'ovos e derivados':                       'ovos',
  'produtos açucarados':                    'acucares',
  'miscelâneas':                            'miscelaneas',
  'outros alimentos industrializados':      'industrializados',
  'alimentos preparados':                   'preparados',
  'bebidas (alcoólicas e não alcoólicas)':  'bebidas',
  'bebidas não alcoólicas':                 'bebidas_na',
  'alimentos para fins especiais':          'especiais',
  'nozes e sementes':                       'nozes',
  'leguminosas e derivados':                'leguminosas',
  'aves e derivados':                       'aves',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNumeric(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (/^(tr|na|\*|-|nd|nc)$/i.test(s)) return null;
  const n = parseFloat(s.replace(',', '.').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function toGroupCode(name) {
  const key = name.toLowerCase().trim();
  if (GROUP_CODE_MAP[key]) return GROUP_CODE_MAP[key];
  return key
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ── Parse main sheet ──────────────────────────────────────────────────────────

function parseMainSheet(ws, XLSX) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const foods = new Map();   // foodNum → food object
  const groups = new Map();  // code → name (ordered)

  let currentGroup = null;
  const DATA_START_ROW = 3;  // rows 0-2 are headers

  for (let ri = DATA_START_ROW; ri < rows.length; ri++) {
    const row = rows[ri];
    const col0 = row[0];

    if (col0 == null) continue;

    // Group header row: col 0 is a string, col 1 is null
    if (typeof col0 === 'string') {
      const marker = col0.toLowerCase().trim();
      if (!HEADER_ROW_MARKERS.has(marker)) {
        currentGroup = { name: col0.trim(), code: toGroupCode(col0.trim()) };
        if (!groups.has(currentGroup.code)) {
          groups.set(currentGroup.code, currentGroup.name);
        }
      }
      continue;
    }

    // Food row: col 0 is a number
    if (typeof col0 !== 'number') continue;

    const foodNum = Math.round(col0);
    const name = row[MAIN_COLS.name];
    if (!name) continue;

    const food = {
      tacoId: `TACO-${String(foodNum).padStart(3, '0')}`,
      name: String(name).trim(),
      groupCode: currentGroup?.code ?? 'outros',
    };

    for (const [field, colIdx] of Object.entries(MAIN_COLS)) {
      if (field === 'num' || field === 'name') continue;
      const val = parseNumeric(row[colIdx]);
      if (val !== null) food[field] = round4(val);
    }

    foods.set(foodNum, food);
  }

  return { foods, groups };
}

// ── Parse fatty acids sheet ───────────────────────────────────────────────────

function parseFattyAcidsSheet(ws, XLSX) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const fatMap = new Map();  // foodNum → fatty acid fields

  const DATA_START_ROW = 3;

  for (let ri = DATA_START_ROW; ri < rows.length; ri++) {
    const row = rows[ri];
    const col0 = row[0];

    if (typeof col0 !== 'number') continue;

    const foodNum = Math.round(col0);
    const entry = {};

    const sat = parseNumeric(row[AG_COLS.saturatedFatG]);
    const mono = parseNumeric(row[AG_COLS.monounsaturatedFatG]);
    const poly = parseNumeric(row[AG_COLS.polyunsaturatedFatG]);
    const trans1 = parseNumeric(row[AG_COLS.transFat18_1]);
    const trans2 = parseNumeric(row[AG_COLS.transFat18_2]);

    if (sat !== null)  entry.saturatedFatG = round4(sat);
    if (mono !== null) entry.monounsaturatedFatG = round4(mono);
    if (poly !== null) entry.polyunsaturatedFatG = round4(poly);

    const transTotal = (trans1 ?? 0) + (trans2 ?? 0);
    if (trans1 !== null || trans2 !== null) {
      entry.transFatG = Math.round(transTotal * 10000) / 10000;
    }

    if (Object.keys(entry).length > 0) {
      fatMap.set(foodNum, entry);
    }
  }

  return fatMap;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    console.error('Missing dependency: xlsx');
    console.error('Install it with: npm install xlsx');
    process.exit(1);
  }

  const inputArg = process.argv[2];
  const inputPath = inputArg ? path.resolve(process.cwd(), inputArg) : DEFAULT_INPUT;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error('Place Taco-4a-Edicao.xlsx in the repo root, or pass the path as an argument.');
    process.exit(1);
  }

  console.log(`Reading: ${inputPath}`);
  const workbook = XLSX.readFile(inputPath, { cellNF: false, cellHTML: false });

  const mainWs = workbook.Sheets['CMVCol taco3'];
  const agWs   = workbook.Sheets['AGtaco3'];

  if (!mainWs) {
    console.error('Sheet "CMVCol taco3" not found. Check the file format.');
    process.exit(1);
  }

  console.log('Parsing main sheet (CMVCol taco3)...');
  const { foods, groups } = parseMainSheet(mainWs, XLSX);
  console.log(`  ${foods.size} foods, ${groups.size} groups`);

  if (agWs) {
    console.log('Parsing fatty acids sheet (AGtaco3)...');
    const fatMap = parseFattyAcidsSheet(agWs, XLSX);
    console.log(`  ${fatMap.size} foods with fatty acid data`);

    for (const [foodNum, fatData] of fatMap) {
      const food = foods.get(foodNum);
      if (food) Object.assign(food, fatData);
    }
  } else {
    console.warn('Sheet "AGtaco3" not found — fatty acids skipped.');
  }

  const groupsArray = [...groups.entries()]
    .filter(([code]) => code.length > 0)
    .map(([code, name]) => ({ name, code }));
  const foodsArray = [...foods.values()];

  const output = {
    converted_at: new Date().toISOString(),
    source: 'TACO 4th edition — NEPA/Unicamp',
    total_foods: foodsArray.length,
    groups: groupsArray,
    foods: foodsArray,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nConverted: ${foodsArray.length} foods, ${groupsArray.length} groups`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('\nNext step: node prisma/seeds/food-seed.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
