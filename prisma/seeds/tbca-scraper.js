/**
 * TBCA Scraper
 *
 * Scrapes https://www.tbca.net.br/ and outputs prisma/seeds/data/tbca.json
 * for use by food-seed.js.
 *
 * Usage:
 *   node prisma/seeds/tbca-scraper.js
 *
 * Resumes from progress file if interrupted.
 * Respects rate limits: ~600ms delay between requests.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, 'data', 'tbca.json');
const PROGRESS_FILE = path.join(__dirname, 'data', 'tbca-progress.json');

const BASE_URL = 'https://www.tbca.net.br/base-dados';
const LISTING_URL = `${BASE_URL}/composicao_alimentos.php`;
const DELAY_MS = 600;

// ── Nutrient rows → schema field mapping ─────────────────────────────────────
// Keys are the exact "Componente" column text (lowercased); unit disambiguates Energia.

const NUTRIENT_MAP = {
  // Energy — disambiguated by unit column
  'energia:kcal': 'energyKcal',
  'energia:kj': 'energyKj',

  // Macros
  'carboidrato disponível': 'carbohydratesG',
  'carboidrato total': 'carbohydratesGTotal', // stored but not in schema; skip
  'proteína': 'proteinG',
  'lipídios': 'totalFatG',
  'fibra alimentar': 'fiberG',
  'cinzas': 'ashG',

  // Fats & cholesterol
  'ácidos graxos saturados': 'saturatedFatG',
  'ácidos graxos monoinsaturados': 'monounsaturatedFatG',
  'ácidos graxos poliinsaturados': 'polyunsaturatedFatG',
  'ácidos graxos trans': 'transFatG',
  'colesterol': 'cholesterolMg',

  // Minerals
  'cálcio': 'calciumMg',
  'ferro': 'ironMg',
  'sódio': 'sodiumMg',
  'magnésio': 'magnesiumMg',
  'fósforo': 'phosphorusMg',
  'potássio': 'potassiumMg',
  'manganês': 'manganeseMg',
  'zinco': 'zincMg',
  'cobre': 'copperMg',
  'selênio': 'seleniumUg',

  // Vitamins
  'vitamina a (rae)': 'vitaminAUgRae',
  'vitamina a (re)': 'vitaminAUgRaeRe',  // fallback if RAE absent
  'vitamina d': 'vitaminDUg',
  'alfa-tocoferol (vitamina e)': 'vitaminEMg',
  'vitamina e': 'vitaminEMg',
  'tiamina': 'thiamineMg',
  'riboflavina': 'riboflavinMg',
  'niacina': 'niacinMg',
  'vitamina b6': 'vitaminB6Mg',
  'vitamina b12': 'vitaminB12Ug',
  'vitamina c': 'vitaminCMg',
  'equivalente de folato': 'folateUg',
  'folato': 'folateUg',
};

// Schema fields that are valid in food-seed.js (others are skipped)
const VALID_FIELDS = new Set([
  'energyKcal', 'energyKj', 'proteinG', 'totalFatG', 'carbohydratesG',
  'fiberG', 'ashG', 'saturatedFatG', 'monounsaturatedFatG', 'polyunsaturatedFatG',
  'transFatG', 'cholesterolMg', 'calciumMg', 'phosphorusMg', 'ironMg', 'sodiumMg',
  'potassiumMg', 'copperMg', 'magnesiumMg', 'manganeseMg', 'zincMg', 'seleniumUg',
  'vitaminAUgRae', 'vitaminDUg', 'vitaminEMg', 'vitaminKUg', 'thiamineMg',
  'riboflavinMg', 'niacinMg', 'vitaminB6Mg', 'folateUg', 'vitaminB12Ug', 'vitaminCMg',
]);

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeEntities(str) {
  return str
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ').replace(/&ccedil;/g, 'ç').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

function parseNumeric(val) {
  if (!val || /^(tr|na|\*|-)$/i.test(val.trim())) return null;
  const n = parseFloat(val.replace(',', '.').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchPage(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TBCA-scraper/1.0)',
          'Accept': 'text/html',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
    }
  }
}

// ── Listing parser ────────────────────────────────────────────────────────────

function parseListing(html) {
  // Links use single quotes: href='int_composicao_alimentos.php?...'
  const links = new Set();
  const linkRegex = /href='(int_composicao_alimentos\.php\?[^']+)'/g;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    links.add(m[1]);
  }
  return [...links];
}

function parseTotalPages(html) {
  // "Exibindo p&aacute;gina 1 de 10"
  const m = decodeEntities(html).match(/Exibindo p[aá]gina \d+ de (\d+)/i);
  return m ? parseInt(m[1], 10) : 10;
}

// ── Detail page parser ────────────────────────────────────────────────────────

function parseDetail(html) {
  // The <h5 id="overview"> contains Código, Grupo, Tipo, Nome Científico, Descrição
  const h5Match = html.match(/<h5[^>]*id=['"]overview['"][^>]*>([\s\S]*?)<\/h5>/i);
  if (!h5Match) return null;

  const h5 = decodeEntities(h5Match[1]);

  // Food code
  const codeM = h5.match(/C[oó]digo:?<\/strong>\s*([A-Z0-9]+)/i);
  const tbcaId = codeM ? codeM[1].trim() : null;

  // Group: "C - Frutas e derivados" → strip letter prefix
  const groupM = h5.match(/Grupo:?<\/strong>\s*([^<]+)/i);
  let groupName = groupM ? stripTags(groupM[1]).trim() : null;
  if (groupName) {
    // Strip "X - " prefix (e.g. "C - " or "A - ")
    groupName = groupName.replace(/^[A-Z]\s*-\s*/, '').trim();
  }

  // Name: after "Descrição:" up to <br>
  const descM = h5.match(/Descri[çc][ãa]o:?<\/strong>\s*([\s\S]*?)(?:<br|$)/i);
  let name = descM ? stripTags(descM[1]).trim() : null;
  // Remove trailing translation brackets << ... >>
  if (name) name = name.replace(/\s*<<[\s\S]*/, '').trim();

  // Nutrient table
  const nutrients = {};

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRegex.exec(html)) !== null) {
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellM;
    while ((cellM = cellRegex.exec(rowM[1])) !== null) {
      cells.push(stripTags(cellM[1]));
    }
    if (cells.length < 3) continue;

    const componentName = cells[0].toLowerCase().trim();
    const unit = cells[1].toLowerCase().trim();
    const valuePer100g = cells[2];

    // Build lookup key (disambiguate Energia by unit)
    const key = componentName === 'energia'
      ? `energia:${unit}`
      : componentName;

    const schemaField = NUTRIENT_MAP[key];
    if (!schemaField) continue;

    // Handle RAE vs RE for Vitamin A: prefer RAE; only set RE if RAE not already set
    if (schemaField === 'vitaminAUgRaeRe') {
      if (!nutrients['vitaminAUgRae']) {
        nutrients['vitaminAUgRae'] = parseNumeric(valuePer100g);
      }
      continue;
    }

    if (!VALID_FIELDS.has(schemaField)) continue;

    const value = parseNumeric(valuePer100g);
    if (value !== null) {
      nutrients[schemaField] = value;
    }
  }

  return { tbcaId, name, groupName, nutrients };
}

// ── Group code slugifier ──────────────────────────────────────────────────────

const GROUP_CODE_OVERRIDES = {
  'frutas e derivados': 'frutas',
  'cereais e derivados': 'cereais',
  'verduras, hortaliças e derivados': 'hortalicas',
  'carnes e derivados': 'carnes',
  'aves e derivados': 'aves',
  'pescados e frutos do mar': 'pescados',
  'leite e derivados': 'leite',
  'ovos e derivados': 'ovos',
  'leguminosas e derivados': 'leguminosas',
  'gorduras e óleos': 'gorduras',
  'açúcares e produtos de confeitaria': 'acucares',
  'bebidas (não alcoólicas)': 'bebidas',
  'bebidas alcoólicas': 'bebidas_alcoolicas',
  'produtos de padaria': 'panificados',
  'alimentos preparados': 'preparados',
  'nozes e sementes': 'nozes',
  'miscelâneas': 'miscelaneas',
  'alimentos para fins especiais': 'especiais',
};

function toGroupCode(groupName) {
  const key = groupName.toLowerCase().trim();
  if (GROUP_CODE_OVERRIDES[key]) return GROUP_CODE_OVERRIDES[key];
  // Partial match
  for (const [phrase, code] of Object.entries(GROUP_CODE_OVERRIDES)) {
    if (key.includes(phrase.split(' ')[0])) return code;
  }
  // Fallback: slugify
  return key
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ── Progress ──────────────────────────────────────────────────────────────────

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return { processedLinks: [], foods: [], groups: {} };
  }
}

function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('TBCA Scraper');
  console.log('Output:', OUTPUT_FILE);

  const progress = loadProgress();
  const processedSet = new Set(progress.processedLinks);

  // ── Step 1: Collect food links ────────────────────────────────────────────
  console.log('\n[1/2] Collecting food links...');
  const firstHtml = await fetchPage(`${LISTING_URL}?pagina=1&atuald=1`);
  const totalPages = parseTotalPages(firstHtml);
  console.log(`  Total pages: ${totalPages}`);

  const allLinks = new Set(parseListing(firstHtml));
  console.log(`  Page 1: ${allLinks.size} unique links`);

  for (let page = 2; page <= totalPages; page++) {
    await sleep(DELAY_MS);
    const html = await fetchPage(`${LISTING_URL}?pagina=${page}&atuald=1`);
    parseListing(html).forEach((l) => allLinks.add(l));
    console.log(`  Page ${page}/${totalPages}: ${allLinks.size} total`);
  }

  const pending = [...allLinks].filter((l) => !processedSet.has(l));
  console.log(`\nTotal: ${allLinks.size} foods | Pending: ${pending.length} | Done: ${processedSet.size}`);

  // ── Step 2: Scrape detail pages ───────────────────────────────────────────
  console.log('\n[2/2] Scraping detail pages...');
  let ok = 0, skip = 0, fail = 0;

  for (let i = 0; i < pending.length; i++) {
    const link = pending[i];
    process.stdout.write(`  [${i + 1}/${pending.length}] `);

    try {
      await sleep(DELAY_MS);
      const html = await fetchPage(`${BASE_URL}/${link}`);
      const result = parseDetail(html);

      if (!result || !result.name) {
        console.log('SKIP (no name parsed)');
        skip++;
      } else {
        const { tbcaId, name, groupName, nutrients } = result;
        const groupCode = groupName ? toGroupCode(groupName) : 'outros';

        if (groupName && !progress.groups[groupCode]) {
          progress.groups[groupCode] = groupName;
        }

        progress.foods.push({ tbcaId, name, groupCode, ...nutrients });
        console.log(`OK  ${name.slice(0, 50)}`);
        ok++;
      }
    } catch (err) {
      console.log(`ERR ${err.message}`);
      fail++;
    }

    progress.processedLinks.push(link);
    if ((i + 1) % 50 === 0) saveProgress(progress);
  }

  saveProgress(progress);

  // ── Write output ──────────────────────────────────────────────────────────
  const groups = Object.entries(progress.groups).map(([code, name]) => ({ name, code }));
  const output = {
    scraped_at: new Date().toISOString(),
    total_foods: progress.foods.length,
    groups,
    foods: progress.foods,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nDone: ${ok} OK, ${skip} skipped, ${fail} failed`);
  console.log(`Written to: ${OUTPUT_FILE}`);
  console.log(`Next step: node prisma/seeds/food-seed.js`);

  if (fail === 0 && skip === 0) {
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
