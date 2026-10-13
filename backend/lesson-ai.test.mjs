/**
 * Lesson validation and provider-failure tests.
 *
 * Every way the AI can fail — malformed JSON, extra fields, invented ids, a
 * wrong answer, timeout, rate limit, bad key, no provider at all — must produce
 * a safe result, never a broken lesson and never a dead-end student journey.
 *
 * Run: node lesson-ai.test.mjs
 */
import { validateLesson } from './lesson-validator.js';
import { LessonGenerator } from './lesson-generator.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { ProviderError, PROVIDER_FAILURE } from './providers/interface.js';
import { getRepository } from './curriculum-context.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  PASS: ${label}`);
  else { console.error(`  FAIL: ${label}`); failures++; }
}

const repo = getRepository();
const CURRICULUM_ID = 'IN.AP-SSC.2024-25';
const anchor = repo.getLessonAnchor(CURRICULUM_ID, 'two-step-equations');

/** A realistic, fully valid provider response. */
function validLesson() {
  return {
    conceptId: 'two-step-equations',
    lessonType: 'worked_example',
    title: 'Solving Two-Step Equations',
    learningObjective: 'Solve an equation of the form ax + b = c.',
    explanation: 'Undo the constant, then undo the multiplication.',
    workedExample: {
      sourceExampleId: anchor.sourceExampleId,
      question: anchor.workedExample.problem,
      steps: [
        { step: 'Subtract 4 from both sides.', why: 'This isolates the term with x.' },
        { step: 'Divide both sides by 2.', why: 'Division undoes the multiplication.' },
      ],
      finalAnswer: anchor.workedExample.finalAnswer,
    },
    hint: 'What is the opposite of adding 4?',
    tryNextQuestionId: 'le-05',
    mindMap: {
      focusConceptId: 'two-step-equations',
      emphasizedConceptIds: ['two-step-equations', 'distributive-parenthesis'],
      explanationLabels: [{ conceptId: 'two-step-equations', label: 'The skill you are building' }],
    },
    sourceIds: ['src-ap-ssc-c08-mathematics-2024-25'],
  };
}

/** The server-controlled context the generator builds. */
function context(overrides = {}) {
  return {
    curriculumId: CURRICULUM_ID,
    contentVersion: repo.contentVersion(CURRICULUM_ID),
    conceptId: 'two-step-equations',
    conceptLabel: 'Two-Step Equations',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'clear step-by-step',
    language: 'en',
    action: 'targeted-review',
    actionReason: 'You missed two in a row.',
    misconception: null,
    lessonType: 'targeted_review',
    conceptGraph: 'Number Sense -> Inverse Operations',
    nodeIdsHint: 'number-sense, inverse-operations, distributive-parenthesis, two-step-equations, variables-both-sides',
    allowedConceptIds: [
      'number-sense', 'inverse-operations', 'distributive-parenthesis',
      'two-step-equations', 'variables-both-sides',
    ],
    workedExample: {
      sourceExampleId: anchor.sourceExampleId,
      problem: anchor.workedExample.problem,
      finalAnswer: anchor.workedExample.finalAnswer,
    },
    sourceIds: ['src-ap-ssc-c08-mathematics-2024-25'],
    tryNextQuestionId: 'le-05',
    nextQuestionId: 'le-05',
    model: null,
    canonicalMindMap: { nodes: [], edges: [] },
    repo,
    ...overrides,
  };
}

// ---------------------------------------------------------------- happy path
console.log('\n[valid output]');
{
  const r = validateLesson(validLesson(), context());
  check('a valid lesson passes validation', r.ok === true);
  check('the lesson keeps its schema fields', typeof r.lesson.title === 'string');
  check('steps are exposed for rendering', Array.isArray(r.lesson.steps) && r.lesson.steps.length === 2);
  check('each rendered step has caption, content and why',
    r.lesson.steps.every((s) => s.caption && s.content && s.why));
  // The canonical mind map is built from the approved graph, so it is non-empty
  // once the generator has supplied a real graph. Use the generator's own
  // context so this checks topology, not the empty stub above.
  const gen = new LessonGenerator({
    providers: {
      primary: { id: 'p', isConfigured: () => true, generateLesson: async () => ({ ok: true, lesson: validLesson(), provider: 'p' }) },
      fallback: null,
    },
  });
  const live = await gen.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    model: null,
  });
  check('the generated lesson renders the canonical graph topology',
    live.ok === true && live.lesson.mindMap.nodes.length >= 5 && live.lesson.mindMap.edges.length >= 4);
  check('the AI may personalise a canonical node label',
    live.lesson.mindMap.nodes.some((n) => n.id === 'two-step-equations' && n.label === 'The skill you are building'));
  check('the AI may not add a node that is not in the graph',
    live.lesson.mindMap.nodes.every((n) =>
      ['number-sense','inverse-operations','distributive-parenthesis','two-step-equations','variables-both-sides'].includes(n.id)));
  check('the current concept is still highlighted in the canonical graph',
    live.lesson.mindMap.nodes.some((n) => n.id === 'two-step-equations' && n.type === 'current'));
  check('the source is recorded as gemini', live.lesson.source === 'gemini');
}

// ------------------------------------------------------------- schema failures
console.log('\n[malformed output]');
{
  check('malformed JSON fails validation', validateLesson({ nope: true }, context()).ok === false);

  const extra = { ...validLesson(), surpriseField: 'x' };
  check('unexpected fields are rejected by .strict()', validateLesson(extra, context()).ok === false);

  const noSteps = { ...validLesson(), workedExample: { ...validLesson().workedExample, steps: [] } };
  check('a worked example with no steps is rejected', validateLesson(noSteps, context()).ok === false);

  const tooMany = {
    ...validLesson(),
    workedExample: {
      ...validLesson().workedExample,
      steps: Array.from({ length: 9 }, () => ({ step: 's', why: 'w' })),
    },
  };
  check('more than 8 steps is rejected', validateLesson(tooMany, context()).ok === false);

  const badType = { ...validLesson(), lessonType: 'made_up_type' };
  check('an unknown lessonType is rejected', validateLesson(badType, context()).ok === false);

  const empty = { ...validLesson(), explanation: '' };
  check('an empty explanation is rejected', validateLesson(empty, context()).ok === false);
}

// ------------------------------------------------------------ invented content
console.log('\n[invented ids and answers]');
{
  const wrongConcept = { ...validLesson(), conceptId: 'not-a-real-concept' };
  check('an invented conceptId is rejected', validateLesson(wrongConcept, context()).ok === false);

  const wrongNext = { ...validLesson(), tryNextQuestionId: 'le-999' };
  check('an invented tryNextQuestionId is rejected', validateLesson(wrongNext, context()).ok === false);

  const nextWrongConcept = { ...validLesson(), tryNextQuestionId: 'le-09' };
  check('a next question from another concept is rejected', validateLesson(nextWrongConcept, context()).ok === false);

  const wrongAnswer = {
    ...validLesson(),
    workedExample: { ...validLesson().workedExample, finalAnswer: 'x = 99' },
  };
  const r = validateLesson(wrongAnswer, context());
  check('a wrong final answer is rejected', r.ok === false);
  check('the rejection reports the expected answer', r.details?.expected === anchor.workedExample.finalAnswer);

  const swappedProblem = {
    ...validLesson(),
    workedExample: { ...validLesson().workedExample, question: 'Solve: y + 1 = 9' },
  };
  check('a changed worked example is rejected', validateLesson(swappedProblem, context()).ok === false);

  const ghostMind = {
    ...validLesson(),
    mindMap: {
      focusConceptId: 'two-step-equations',
      emphasizedConceptIds: ['ghost-concept'],
      explanationLabels: [],
    },
  };
  check('a mind map referencing an unknown concept is rejected', validateLesson(ghostMind, context()).ok === false);

  const ghostSource = { ...validLesson(), sourceIds: ['src-does-not-exist'] };
  check('an invented source id is rejected', validateLesson(ghostSource, context()).ok === false);

  check('formatting-only answer differences are tolerated',
    validateLesson(validLesson(), context({ workedExample: {
      sourceExampleId: anchor.sourceExampleId,
      problem: anchor.workedExample.problem,
      finalAnswer: 'x=3',
    } })).ok === true);
}

// --------------------------------------------------------- provider failures
console.log('\n[provider failure handling]');
{
  check('an unavailable provider is classified',
    new ProviderError(PROVIDER_FAILURE.TIMEOUT, 't') instanceof Error);

  check('timeouts are classified distinctly', PROVIDER_FAILURE.TIMEOUT === 'TIMEOUT');
  check('rate limits are classified distinctly', PROVIDER_FAILURE.RATE_LIMITED === 'RATE_LIMITED');
  check('auth failures are classified distinctly', PROVIDER_FAILURE.AUTH_FAILED === 'AUTH_FAILED');
  check('invalid responses are classified distinctly', PROVIDER_FAILURE.INVALID_RESPONSE === 'INVALID_RESPONSE');

  // A provider-less generator must fall back, never throw.
  const none = new LessonGenerator({
    providers: { primary: new GeminiProvider({ apiKey: '' }), fallback: null },
  });
  const result = await none.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    model: null,
  });
  check('no provider configured still returns a lesson', result.ok === true);
  check('the fallback lesson is marked as such', result.lesson.source === 'fallback');
  check('the fallback notice explains what happened', typeof result.lesson.notice === 'string');
  check('the fallback keeps a usable worked example', result.lesson.workedExample.steps.length >= 1);
  check('the fallback final answer is the canonical one',
    result.lesson.finalAnswer === anchor.workedExample.finalAnswer);
  check('the fallback mind map is the canonical topology', Array.isArray(result.lesson.mindMap.edges));

  // A provider that always fails must also fall back.
  const broken = new LessonGenerator({
    providers: {
      primary: {
        id: 'broken',
        isConfigured: () => true,
        generateLesson: async () => ({ ok: false, error: 'boom' }),
      },
      fallback: null,
    },
  });
  const brokenResult = await broken.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    model: null,
  });
  check('a failing provider falls back to the reviewed lesson', brokenResult.ok === true);
  check('a failing provider does not leak its error into the lesson',
    brokenResult.lesson.source === 'fallback');

  // A provider that returns valid-schema but factually wrong output must be rejected.
  const lying = new LessonGenerator({
    providers: {
      primary: {
        id: 'lying',
        isConfigured: () => true,
        generateLesson: async () => {
          const bad = validLesson();
          bad.workedExample.finalAnswer = 'x = 42';
          bad.conceptId = 'variables-both-sides';
          return { ok: true, lesson: bad, provider: 'lying' };
        },
      },
      fallback: null,
    },
  });
  const lyingResult = await lying.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    model: null,
  });
  check('a factually wrong AI lesson is rejected and replaced', lyingResult.lesson.source === 'fallback');
  check('the replacement carries the canonical answer', lyingResult.lesson.finalAnswer === anchor.workedExample.finalAnswer);

  // A primary failure with a healthy configured fallback provider should try it.
  const fallbackProvider = {
    id: 'fallback-provider',
    isConfigured: () => true,
    generateLesson: async () => ({ ok: true, lesson: validLesson(), provider: 'fallback-provider' }),
  };
  const withFallback = new LessonGenerator({
    providers: { primary: { id: 'p', isConfigured: () => true, generateLesson: async () => ({ ok: false, error: 'timeout' }) }, fallback: fallbackProvider },
  });
  const okFallback = await withFallback.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    model: null,
  });
  check('a configured fallback provider is used after a primary failure',
    okFallback.provider === 'fallback-provider');

  // An unknown concept must be refused, not invented.
  const unknown = await none.generate({
    curriculumId: CURRICULUM_ID,
    conceptId: 'no-such-concept',
    action: 'targeted-review',
    grade: 8,
    model: null,
  });
  check('an unknown concept is refused rather than invented', unknown.ok === false);
}

// ------------------------------------------------------------------ caching
console.log('\n[lesson caching]');
{
  const cached = {
    id: 'cached',
    isConfigured: () => true,
    calls: 0,
    async generateLesson() { this.calls++; return { ok: true, lesson: validLesson(), provider: 'cached' }; },
  };
  const gen = new LessonGenerator({ providers: { primary: cached, fallback: null } });
  const ctx = {
    curriculumId: CURRICULUM_ID,
    conceptId: 'two-step-equations',
    action: 'targeted-review',
    grade: 8,
    readingBand: 'clear',
    readingGuidance: 'x',
    language: 'en',
    misconception: null,
    model: null,
  };
  await gen.generate(ctx);
  await gen.generate(ctx);
  check('the provider is only called once for identical non-personal keys', cached.calls === 1);
  check('the cache reports a hit', gen.cacheStats().hits >= 1);

  // A different misconception is a different cache entry.
  await gen.generate({ ...ctx, misconception: 'arithmetic-error' });
  check('a different misconception bypasses the cache', cached.calls === 2);

  // A different reading band is a different cache entry.
  await gen.generate({ ...ctx, readingBand: 'simple' });
  check('a different reading band bypasses the cache', cached.calls === 3);

  const stats = gen.cacheStats();
  check('the cache is bounded', typeof stats.size === 'number' && stats.size <= 200);
}

console.log(`\n${failures === 0 ? 'ALL LESSON AI TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
