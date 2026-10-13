/**
 * Content-pack validation tests — the gate that stops fabricated curriculum.
 * Run: node curriculum.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REAL_PACK = join(REPO_ROOT, 'content-packs');

const { CurriculumRepository } = await import('../backend/curriculum/repository.js');

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  PASS: ${label}`);
  else { console.error(`  FAIL: ${label}`); failures++; }
}

/** Copy the real pack into a temp tree so tests can mutate it safely. */
function copyRealPack() {
  const tmp = join(REPO_ROOT, 'backend', '.tmp-pack-test');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  cpSync(REAL_PACK, tmp, { recursive: true });
  return tmp;
}

function loadFrom(tmp, mutate) {
  if (mutate) mutate();
  const repo = new CurriculumRepository({ packRoot: tmp });
  repo.load();
  return repo;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2));

// --------------------------------------------------------------- real packs
console.log('\n[real pack integrity]');
{
  const repo = loadFrom(REAL_PACK);
  check('the on-disk pack loads with zero errors', repo.loadErrors.length === 0);
  check('exactly one curriculum is loaded', repo.listCurricula().length === 1);
  const curriculum = repo.listCurricula()[0];
  check('the curriculum names a real board', /Andhra Pradesh/.test(curriculum.board));
  check('sources carry an issuing organisation',
    [...repo.sources.values()].every((s) => s.issuingOrganisation.length > 3));
  check('every source records a review status',
    [...repo.sources.values()].every((s) => ['unverified','pending_review','reviewed','verified','rejected'].includes(s.reviewStatus)));
  check('the verified bank still has 12 questions', repo.listQuestions(curriculum.id).length === 12);
  check('no unverified question is served',
    repo.listQuestions(curriculum.id).every((q) => q.verificationStatus === 'verified' || q.verificationStatus === 'reviewed'));
  check('every question has a concept in the pack',
    repo.listQuestions(curriculum.id).every((q) => repo.getConcept(curriculum.id, q.conceptId)));
  check('no question leaks its answer key in an approved list',
    repo.listQuestions(curriculum.id).every((q) => typeof q.correctOptionId === 'string'));
}

// ------------------------------------------------------------- missing fields
console.log('\n[schema violations]');
{
  const tmp = copyRealPack();
  let repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    const qs = readJson(p);
    qs.push({
      id: 'le-bad',
      curriculumId: 'IN.AP-SSC.2024-25', grade: 8, subjectId: 'mathematics',
      chapterId: 'ap-ssc-2024-25-c08-mat-linear-equations',
      conceptId: 'number-sense', difficulty: 1, type: 'multiple-choice',
      prompt: 'Solve: x + 1 = 2',
      options: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }],
      correctOptionId: 'a', verificationStatus: 'verified', version: 1,
    });
    writeJsonSync(p, qs);
  });
  check('a question missing its misconception map is rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    const qs = readJson(p);
    writeJsonSync(p, qs.map((q) => (q.id === 'le-01' ? { ...q, correctOptionId: 'opt-does-not-exist' } : q)));
  });
  check('a correctOptionId outside the options is rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    const qs = readJson(p);
    writeJsonSync(p, qs.map((q) => (q.id === 'le-01'
      ? { ...q, options: [...q.options, { id: q.options[0].id, text: 'x = 7' }] }
      : q)));
  });
  check('duplicate option ids are rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    writeJsonSync(p, readJson(p).map((q) => (q.id === 'le-01' ? { ...q, difficulty: 9 } : q)));
  });
  check('an out-of-range difficulty is rejected', repo.loadErrors.length > 0);

  rmSync(tmp, { recursive: true, force: true });
}

function writeJsonSync(p, data) { writeFileSync(p, JSON.stringify(data, null, 2)); }

// ---------------------------------------------------------- broken references
console.log('\n[broken references]');
{
  const tmp = copyRealPack();
  let repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    writeJsonSync(p, readJson(p).map((q) => (q.id === 'le-01' ? { ...q, conceptId: 'no-such-concept' } : q)));
  });
  check('a question pointing at an unknown concept is rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/resources.json');
    writeJsonSync(p, readJson(p).map((r) => (r.id.startsWith('res-ap-ssc-c08-maths-sem1') ? { ...r, conceptIds: ['ghost-concept'] } : r)));
  });
  check('a resource pointing at an unknown concept is rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/resources.json');
    writeJsonSync(p, readJson(p).map((r) => ({ ...r, url: undefined })));
  });
  check('a resource with neither URL nor contentRef is rejected', repo.loadErrors.length > 0);

  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/pack.json');
    const m = readJson(p);
    m.sources = [];
    writeJsonSync(p, m);
  });
  check('a pack with no provenance sources is rejected', repo.loadErrors.length > 0);

  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------ duplicate ids
console.log('\n[duplicate and cycle]');
{
  const tmp = copyRealPack();
  let repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/questions.json');
    const qs = readJson(p);
    writeJsonSync(p, [...qs, { ...qs[0] }]);
  });
  check('duplicate question ids do not create a second entry',
    repo.questions.size === 12);

  // A self-referential prerequisite must be caught.
  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/concepts.json');
    writeJsonSync(p, readJson(p).map((c) => (c.id === 'number-sense' ? { ...c, prerequisiteConceptIds: ['number-sense'] } : c)));
  });
  check('a concept listing itself as a prerequisite is rejected', repo.loadErrors.length > 0);

  // A two-node cycle must be caught.
  repo = loadFrom(tmp, () => {
    const p = join(tmp, 'IN/AP-SSC/2024-25/class-08/mathematics/concepts.json');
    writeJsonSync(p, readJson(p).map((c) => (c.id === 'inverse-operations'
      ? { ...c, prerequisiteConceptIds: ['number-sense'] }
      : c.id === 'number-sense'
      ? { ...c, prerequisiteConceptIds: ['inverse-operations'] }
      : c)));
  });
  check('a cycle in the prerequisite graph is detected', repo.loadErrors.length > 0);

  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------- grade/board isolation
console.log('\n[curriculum isolation]');
{
  const tmp = copyRealPack();
  const repo = loadFrom(tmp);
  const id = 'IN.AP-SSC.2024-25';

  check('grade 8 is a supported grade', repo.listCurricula()[0].supportedGrades.includes(8));
  check('an unsupported grade is refused', (() => {
    try { repo.listSubjects(id, 9); return false; } catch (e) { return e.code === 'GRADE_NOT_AVAILABLE'; }
  })());
  check('an unknown curriculum is refused', (() => {
    try { repo.assertCurriculum('IN.NOPE.2026'); return false; } catch (e) { return e.code === 'CURRICULUM_NOT_FOUND'; }
  })());
  check('a chapter cannot be read from another grade',
    repo.listChapters(id, 10, 'mathematics').length === 0);
  check('class 8 mathematics is assessment_ready',
    repo.listSubjects(id, 8).find((s) => s.id === 'mathematics').coverage === 'assessment_ready');
  check('class 10 mathematics is honestly catalog_only',
    repo.listSubjects(id, 10).find((s) => s.id === 'mathematics').coverage === 'catalog_only');
  check('class 10 has no questions at all, not fabricated ones',
    repo.listQuestions(id, { grade: 10 }).length === 0);
  check('class 10 resources are only the real official textbook links',
    repo.listResourcesForConcept(id, 'anything').length === 0);
  check('concepts are ordered root-first',
    repo.conceptsInOrder(id)[0] === 'number-sense');
  check('the graph has no cycles to walk',
    repo.conceptsInOrder(id).length === 5);
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------- seed idempotency
console.log('\n[seed idempotency]');
{
  // A seed run must be repeatable: loading twice must not change counts.
  const tmp = copyRealPack();
  const first = loadFrom(tmp);
  const firstCounts = {
    questions: first.questions.size,
    concepts: first.concepts.size,
    chapters: first.chapters.size,
    resources: first.resources.size,
  };
  const second = loadFrom(tmp);
  check('a second load produces identical counts',
    JSON.stringify(firstCounts) === JSON.stringify({
      questions: second.questions.size,
      concepts: second.concepts.size,
      chapters: second.chapters.size,
      resources: second.resources.size,
    }));
  check('reviewed content is not duplicated by a re-seed',
    second.questions.size === firstCounts.questions);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CURRICULUM TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
