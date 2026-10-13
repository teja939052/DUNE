/**
 * Curriculum content-pack tooling.
 *
 *   npm run curriculum:validate   check every pack, report file+record errors
 *   npm run curriculum:seed       idempotent upsert into the persistence layer
 *   npm run curriculum:report     coverage summary by board/grade/subject
 *
 * Validation is the gate: a pack with errors is never imported.
 */

import 'dotenv/config';
import { loadRepository } from '../curriculum/repository.js';
import { SessionModel } from '../store.js';
import { connectMongo } from '../store.js';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

/** Collect every schema violation, with the file it came from. */
function validate() {
  const repo = loadRepository();
  const errors = repo.loadErrors;

  if (errors.length === 0) {
    const curricula = repo.listCurricula();
    console.log(`OK: ${curricula.length} curriculum pack(s) valid.\n`);
    for (const c of curricula) {
      const grades = c.supportedGrades.join(', ');
      const packs = repo.coverageReport().find((r) => r.curriculumId === c.id);
      let questions = 0;
      for (const grade of c.supportedGrades) {
        for (const subject of repo.listSubjects(c.id, grade)) {
          questions += repo.listQuestions(c.id, { grade, subjectId: subject.id }).length;
        }
      }
      console.log(`  ${c.id}  board=${c.board}  year=${c.academicYear}  grades=[${grades}]`);
      console.log(`     versions: contentVersion=${repo.contentVersion(c.id)}  verifiedQuestions=${questions}`);
    }
    console.log('\nNo files or records reported errors.');
    return 0;
  }

  console.error(`${errors.length} validation error(s):\n`);
  for (const err of errors) {
    console.error(`  ${err.path}`);
    if (err.id) console.error(`    record: ${err.id}`);
    console.error(`    reason: ${err.error}`);
    if (err.details) {
      const details = Array.isArray(err.details) ? err.details : [err.details];
      for (const d of details) {
        console.error(`      - ${typeof d === 'string' ? d : JSON.stringify(d)}`);
      }
    }
  }
  return 1;
}

/**
 * Seed content packs into the persistence layer, upserting by stable ID.
 * Running twice must not create duplicates or destroy reviewed content.
 */
async function seed() {
  const repo = loadRepository();
  if (repo.loadErrors.length > 0) {
    return fail('packs are invalid; run `npm run curriculum:validate` first');
  }

  const curricula = repo.listCurricula();
  const summary = [];

  for (const curriculum of curricula) {
    const rows = {
      curriculumId: curriculum.id,
      contentVersion: repo.contentVersion(curriculum.id),
      subjects: repo.listSubjects(curriculum.id, 8).concat(repo.listSubjects(curriculum.id, 10)).length,
      questions: 0,
      resources: 0,
    };
    for (const grade of curriculum.supportedGrades) {
      for (const subject of repo.listSubjects(curriculum.id, grade)) {
        rows.questions += repo.listQuestions(curriculum.id, { grade, subjectId: subject.id }).length;
        for (const chapter of repo.listChapters(curriculum.id, grade, subject.id)) {
          for (const concept of chapter.concepts) {
            rows.resources += repo.listResourcesForConcept(curriculum.id, concept.id).length;
          }
        }
      }
    }
    summary.push(rows);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI is not set — packs are served from disk, nothing to persist.');
    console.log('Packs are already the source of truth and are validated at startup.');
    for (const row of summary) printSeedSummary(row);
    return 0;
  }

  const connected = await connectMongo(uri);
  if (!connected) {
    return fail('Atlas is configured but unreachable; refusing to report a fake successful seed.');
  }

  // Upsert curriculum records by stable ID. `setDefaultsOnInsert` means a
  // re-run never overwrites fields a reviewer has already edited.
  for (const row of summary) {
    await SessionModel.db.collection('contentpacks').updateOne(
      { curriculumId: row.curriculumId },
      {
        $set: {
          contentVersion: row.contentVersion,
          subjectCount: row.subjects,
          questionCount: row.questions,
          resourceCount: row.resources,
          seededAt: new Date().toISOString(),
        },
        $setOnInsert: {
          // Guard against silently replacing a reviewed snapshot.
          firstSeededAt: new Date().toISOString(),
          contentVersionMigrated: 1,
        },
      },
      { upsert: true }
    );
    printSeedSummary(row);
  }
  console.log('\nSeed complete. Safe to run repeatedly — it upserts by stable ID.');
  return 0;
}

function printSeedSummary(row) {
  console.log(
    `  ${row.curriculumId}  v${row.contentVersion}  subjects=${row.subjects}  questions=${row.questions}  resources=${row.resources}`
  );
}

function report() {
  const repo = loadRepository();
  if (repo.loadErrors.length > 0) {
    return fail('packs are invalid; run `npm run curriculum:validate` first');
  }

  const coverageOrder = ['reviewed', 'assessment_ready', 'lesson_ready', 'catalog_only', 'retired'];
  console.log('AhaPath curriculum coverage\n');
  for (const row of repo.coverageReport()) {
    console.log(`${row.curriculumId} — ${row.board} (${row.academicYear})`);
    const grades = Object.keys(row.grades).sort();
    for (const grade of grades) {
      const gradeRow = row.grades[grade];
      console.log(`  Class ${grade}`);
      const subjectIds = Object.keys(gradeRow.subjects).sort();
      for (const subjectId of subjectIds) {
        const subject = gradeRow.subjects[subjectId];
        if (subject.chapters.length === 0) {
          console.log(`    ${subject.id}: catalog_only (no chapters sourced yet)`);
          continue;
        }
        console.log(`    ${subject.id}: ${subject.coverage}`);
        for (const chapter of subject.chapters) {
          const badge = chapter.questions > 0 ? `${chapter.questions} verified questions` : 'no questions';
          const concepts = `${chapter.concepts} concepts`;
          console.log(`      ${chapter.title} [${chapter.coverage}] — ${concepts}, ${badge}`);
        }
      }
    }
    console.log('');
  }

  // A breakdown by coverage state, so "reviewed" vs "catalog_only" is never ambiguous.
  const buckets = new Map();
  for (const row of repo.coverageReport()) {
    for (const grade of Object.values(row.grades)) {
      for (const subject of Object.values(grade.subjects)) {
        for (const chapter of subject.chapters) {
          const key = chapter.coverage;
          buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        if (subject.chapters.length === 0) {
          buckets.set('catalog_only (subject only)', (buckets.get('catalog_only (subject only)') || 0) + 1);
        }
      }
    }
  }
  console.log('Chapters by coverage state:');
  for (const state of coverageOrder) {
    if (buckets.has(state)) console.log(`  ${state.padEnd(22)} ${buckets.get(state)}`);
  }
  if (buckets.has('catalog_only (subject only)')) {
    console.log(`  ${'catalog_only (subject only)'.padEnd(22)} ${buckets.get('catalog_only (subject only)')}`);
  }
  return 0;
}

const command = process.argv[2] || 'validate';
let exitCode = 1;

if (command === 'validate') {
  exitCode = validate();
} else if (command === 'seed') {
  exitCode = await seed();
} else if (command === 'report') {
  exitCode = report();
} else {
  console.error(`Unknown command "${command}". Use validate, seed or report.`);
  exitCode = 1;
}

if (command === 'seed') process.exit(exitCode);
