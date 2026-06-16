#!/usr/bin/env node
/**
 * Seed script: reads JSON data files and inserts them into Supabase.
 *
 * Usage:
 *   SUPABASE_SERVICE_KEY=sb_secret_... node scripts/seed.mjs [--user NAME] [USER_UUID]
 *
 * Options:
 *   --user NAME   Seed data folder name under scripts/seed-data/ (default: "alex")
 *   USER_UUID     Target Supabase user ID (overrides default for the chosen user)
 *
 * Examples:
 *   node scripts/seed.mjs                                        # seed alex (default)
 *   node scripts/seed.mjs --user natalia e3b4df38-...            # seed natalia
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.resolve('../frontend/package.json'));
const { createClient } = require('@supabase/supabase-js');
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = 'https://hvcfhywtbsxpgjxlvxww.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error('Set SUPABASE_SERVICE_KEY env var (find it in Supabase > Settings > API Keys > Secret key)');
  process.exit(1);
}

// Parse arguments
const args = process.argv.slice(2);
let userName = 'alex';
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user' && i + 1 < args.length) {
    userName = args[++i];
  } else {
    positional.push(args[i]);
  }
}

const DEFAULT_USER_IDS = {
  alex: 'f49e8347-87a5-46bf-b771-bb45ede2786f',
  natalia: '17bc7ed4-6fcb-402c-bcce-d50d05ffc835',
};

const TARGET_USER_ID = positional[0] || DEFAULT_USER_IDS[userName];
if (!TARGET_USER_ID) {
  console.error(`No default UUID for user "${userName}". Pass a UUID as argument.`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const DATA_DIR = join(import.meta.dirname, 'seed-data', userName);
const RESULTS_DIR = join(DATA_DIR, 'results-by-date');

async function seed() {
  console.log(`Seeding data for user ${TARGET_USER_ID}...`);

  // 0. Clean existing data for this user
  console.log('Cleaning existing data...');
  const { error: delRes } = await sb.from('results').delete().eq('user_id', TARGET_USER_ID);
  if (delRes) console.error('  Error deleting results:', delRes.message);
  const { error: delSess } = await sb.from('test_sessions').delete().eq('user_id', TARGET_USER_ID);
  if (delSess) console.error('  Error deleting sessions:', delSess.message);
  const { error: delPlan } = await sb.from('planned_tests').delete().eq('user_id', TARGET_USER_ID);
  if (delPlan) console.error('  Error deleting planned:', delPlan.message);
  console.log('  Cleaned.');

  // 1. Read manifest
  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, 'manifest.json'), 'utf-8'));
  console.log(`Found ${manifest.length} test sessions in manifest`);

  let totalResults = 0;

  // Skip future dates and empty sessions
  const today = new Date().toISOString().slice(0, 10);
  const realEntries = manifest.filter(e => {
    if (e.date > today) return false;
    if (e.numericItems === 0) return false;
    return true;
  });
  console.log(`Skipping ${manifest.length - realEntries.length} future/placeholder sessions`);

  for (const entry of realEntries) {
    const fileName = entry.file.replace(/\\/g, '/').split('/').pop();
    const filePath = join(RESULTS_DIR, fileName);

    let sessionData;
    try {
      sessionData = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`  Skipping ${fileName}: ${e.message}`);
      continue;
    }

    // Derive lab name: explicit labName field, or extract from filename (e.g. "2025-08-01__neogenesis.json" → "NeoGenesis")
    let labName = sessionData.labName || null;
    if (!labName) {
      const match = fileName.match(/__(.+)\.json$/);
      if (match) {
        const raw = match[1].replace(/-/g, ' ');
        labName = raw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
    }

    // Insert test_session
    const { data: session, error: sessErr } = await sb
      .from('test_sessions')
      .upsert({
        user_id: TARGET_USER_ID,
        date: sessionData.date,
        place: labName,
        source_file: sessionData.sourceFile || null,
      }, { onConflict: 'user_id,date,place' })
      .select('id')
      .single();

    if (sessErr) {
      console.error(`  Error inserting session ${entry.date} ${labName}:`, sessErr.message);
      continue;
    }

    console.log(`  Session ${sessionData.date} @ ${labName} → ${session.id}`);

    // Insert results for this session
    const items = sessionData.items || [];
    if (items.length === 0) continue;

    const resultRows = items
      .filter(r => r.value != null || r.rawValue != null) // skip empty/planned markers
      .map(r => ({
        session_id: session.id,
        user_id: TARGET_USER_ID,
        loinc: r.loinc || null,
        analysis: r.analysis || null,
        symbol: r.symbol || null,
        section: r.section || null,
        value: r.value != null ? r.value : null,
        raw_value: r.rawValue || null,
        value_qualifier: r.valueQualifier || null,
        unit: r.unit || null,
        ref_text: r.refText || null,
        ref_min: r.refMin != null ? r.refMin : null,
        ref_max: r.refMax != null ? r.refMax : null,
        method: r.method || null,
      }));

    if (resultRows.length > 0) {
      const { error: resErr } = await sb.from('results').insert(resultRows);
      if (resErr) {
        console.error(`    Error inserting results:`, resErr.message);
      } else {
        totalResults += resultRows.length;
        console.log(`    Inserted ${resultRows.length} results`);
      }
    }
  }

  // 2. Seed planned tests (optional file)
  const plannedPath = join(DATA_DIR, 'planned.json');
  const planned = existsSync(plannedPath) ? JSON.parse(readFileSync(plannedPath, 'utf-8')) : [];
  if (planned.length > 0) {
    const plannedRows = planned.map(p => ({
      user_id: TARGET_USER_ID,
      planned_date: p.plannedDate || null,
      test_type: p.testType || null,
      notes: p.notes || null,
    }));

    const { error: planErr } = await sb.from('planned_tests').insert(plannedRows);
    if (planErr) {
      console.error('Error inserting planned tests:', planErr.message);
    } else {
      console.log(`Inserted ${plannedRows.length} planned tests`);
    }
  }

  console.log(`\nDone! Seeded ${manifest.length} sessions, ${totalResults} results, ${planned.length} planned tests.`);
}

seed().catch(err => { console.error(err); process.exit(1); });
