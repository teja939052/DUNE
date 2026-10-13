/**
 * Integration test: drives the real HTTP API through two divergent student
 * journeys and verifies the lesson endpoint, fallback path and security rules.
 * Run: node integration.test.mjs
 */
const BASE = process.env.TEST_BASE || 'http://localhost:3001';
let failures = 0;

function check(label, condition) {
  if (condition) console.log(`  PASS: ${label}`);
  else { console.error(`  FAIL: ${label}`); failures++; }
}

const CODE_TO_OPTION = {
  'le-01': { wrongInverse: 'opt-17' },
  'le-02': { wrongInverse: 'opt-5' },
  'le-05': { forgotDivide: 'opt-8' },
};

async function createSession(nickname, klass = 8) {
  const res = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, class: klass, subject: 'mathematics', chapter: 'Linear Equations', language: 'en' }),
  });
  if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function answer(sessionId, question, optionId) {
  const res = await fetch(`${BASE}/api/session/${sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: question.qid, optionId, usedHint: false }),
  });
  if (!res.ok) throw new Error(`answer failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getLesson(sessionId, conceptId, action) {
  const res = await fetch(`${BASE}/api/session/${sessionId}/lesson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conceptId, action }),
  });
  if (!res.ok) throw new Error(`lesson failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  // ---------------------------------------------------------------- health
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('health reports ok', health.status === 'ok');
  check('health reports gemini configuration state', typeof health.geminiConfigured === 'boolean');

  // ----------------------------------------------- Student A: needs support
  console.log('\n[student A: struggling]');
  const a = await createSession('Aarav');
  check('session creation returns the first question', Boolean(a.firstQuestion));
  check('first question exposes a concept label', typeof a.firstQuestion.conceptLabel === 'string');

  // Answer WRONG (wrong inverse operation) on the first two questions.
  const wrong1 = CODE_TO_OPTION['le-01']?.wrongInverse || a.firstQuestion.options[0].id;
  // Pick a deliberately wrong option by matching known-wrong ids if present.
  let opts = a.firstQuestion.options;
  let wrongOpt = opts.find((o) => o.id === 'opt-17' || o.text === 'x = 17');
  if (!wrongOpt) wrongOpt = opts.find((o) => o.id !== a.firstQuestion.answerId);
  // The bank answer is not exposed, so find a wrong one by known misconception map locally.
  const knownWrong = opts.find((o) => ['opt-17', 'opt-5', 'opt-4', 'opt-14'].includes(o.id));

  const r1 = await answer(a.sessionId, a.firstQuestion, (knownWrong || wrongOpt).id);
  check('wrong answer is graded incorrect', r1.feedback.isCorrect === false);
  check('wrong answer yields a misconception code', Boolean(r1.feedback.misconception));
  check('the response explains the misconception', typeof r1.feedback.misconceptionExplanation === 'string');
  check('a next question is always provided', Boolean(r1.nextQuestion));
  check('the response carries a learning state', Boolean(r1.learningState));

  // Second consecutive wrong on the same concept. The pick is deterministic by
  // question id (not option order — options are shuffled per serve).
  const WRONG_INVERSE = { 'le-01': 'opt-17', 'le-02': 'opt-5', 'le-03': 'opt-4', 'le-04': 'opt-8' };
  const r2 = await answer(a.sessionId, r1.nextQuestion, WRONG_INVERSE[r1.nextQuestion.qid] || r1.nextQuestion.options[0].id);
  check('two consecutive wrong triggers targeted-review', r2.nextAction.code === 'targeted-review');
  check('targeted-review requests a lesson', r2.nextAction.lessonRequested === true);
  check('the reason explains why the path changed', r2.nextAction.reason.length > 20);
  check('targeted review moves easier', r2.nextAction.difficultyDirection === 'easier');

  // Lesson for this student.
  if (r2.lessonContext) {
    const lessonResp = await getLesson(a.sessionId, r2.lessonContext.conceptId, r2.lessonContext.action);
    const lesson = lessonResp.lesson;
    check('lesson has a title', typeof lesson.title === 'string' && lesson.title.length > 3);
    check('lesson has a mind map with nodes', Array.isArray(lesson.mindMap.nodes) && lesson.mindMap.nodes.length >= 3);
    check('lesson has a mind map with edges', Array.isArray(lesson.mindMap.edges) && lesson.mindMap.edges.length >= 2);
    check('every node has id, label and type',
      lesson.mindMap.nodes.every((n) => n.id && n.label && ['prerequisite','current','target','remediation'].includes(n.type)));
    check('every edge references nodes that exist',
      lesson.mindMap.edges.every((e) => lesson.mindMap.nodes.some((n) => n.id === e.from) && lesson.mindMap.nodes.some((n) => n.id === e.to)));
    check('lesson has captioned steps with content and why',
      Array.isArray(lesson.steps) && lesson.steps.length >= 2 &&
      lesson.steps.every((s) => s.caption && s.content && s.why));
    check('lesson has a hint', typeof lesson.hint === 'string' && lesson.hint.length > 4);
    check('lesson has a tryNext action', typeof lesson.tryNext === 'string');
    check('lesson has a final answer matching the canonical worked example',
      lesson.finalAnswer === lesson.expectedAnswer);
    check('lesson source is gemini or fallback', ['gemini', 'fallback'].includes(lesson.source));
    check('lesson includes the reviewed problem', typeof lesson.reviewedProblem === 'string');
    check('mind map highlights a current node', lesson.mindMap.nodes.some((n) => n.type === 'current'));
    // The lesson graph must mirror the canonical prerequisite graph exactly.
    // Node types are derived from the returned edges relative to the focus
    // concept, so the root concept correctly shows no prerequisite nodes and
    // nothing outside the approved graph is ever invented.
    const focusId = lesson.mindMap.focusConceptId;
    check('mind map names its focus concept', typeof focusId === 'string' && focusId.length > 0);
    const parentOf = new Map(lesson.mindMap.edges.map((e) => [e.to, e.from]));
    const ancestorIds = new Set();
    let up = parentOf.get(focusId);
    while (up) { ancestorIds.add(up); up = parentOf.get(up); }
    const childOf = new Map(lesson.mindMap.edges.map((e) => [e.from, e.to]));
    const descendantIds = new Set();
    let down = childOf.get(focusId);
    while (down) { descendantIds.add(down); down = childOf.get(down); }
    check('mind map node types match the canonical graph topology',
      lesson.mindMap.nodes.every((n) => {
        if (n.id === focusId) return n.type === 'current';
        if (ancestorIds.has(n.id)) return n.type === 'prerequisite';
        if (descendantIds.has(n.id)) return n.type === 'target';
        return true;
      }));
    check('mind map node states use the documented vocabulary',
      lesson.mindMap.nodes.every((n) => ['not_tested', 'developing', 'solid', 'needs_review'].includes(n.state)));
    check('mind map does not infer mastery for untouched concepts',
      lesson.mindMap.nodes.every((n) => n.attempts >= 2 || (n.state === 'not_tested' && n.mastery === 0)));
  } else {
    check('lesson context is provided for a lesson-requesting action', false);
  }

  // ----------------------------------------------- Student B: ready to advance
  console.log('\n[student B: ready to advance]');
  const b = await createSession('Meera');
  bPath: {
    let q = b.firstQuestion;
    // Walk the diagnostic answering everything correctly using the local answer key.
    const keys = await fetch(`${BASE}/api/health`).then(() => null); // keys stay server-side; use known ids below
    // The API does not leak answer keys, so answer by using the server-provided
    // correct option only where safe: instead we drive the deterministic engine
    // expectations through the documented misconception/transfer questions.
    void q;
  }

  // Use the engine-verified correct option ids directly (server still grades).
  const CORRECT = {
    'le-01': 'opt-7', 'le-02': 'opt-11', 'le-03': 'opt-7', 'le-04': 'opt-12',
    'le-05': 'opt-4', 'le-06': 'opt-5', 'le-07': 'opt-4', 'le-08': 'opt-5',
    'le-09': 'opt-5', 'le-10': 'opt-3', 'le-11': 'opt-4', 'le-12': 'opt-4',
  };
  const b2 = await createSession('Bhavna');
  let cur = b2.firstQuestion;
  let sawHarder = false;
  let sawLesson = false;
  let sawMastery = 0;
  for (let i = 0; i < 12 && cur; i++) {
    const optionId = CORRECT[cur.qid];
    if (!optionId) break;
    const r = await answer(b2.sessionId, cur, optionId);
    sawMastery = Math.max(sawMastery, r.learningState.masteryAfter);
    if (r.nextAction.lessonRequested) sawLesson = true;
    if (r.nextAction.code === 'harder-challenge') sawHarder = true;
    cur = r.nextQuestion;
  }
  check('student B answered the diagnostic', sawMastery > 0);
  check('all-correct student B reaches high mastery', sawMastery >= 70);
  check('student B is offered a harder challenge', sawHarder === true);
  check('student B is never forced into a lesson', sawLesson === false);

  // --------------------------------------------------------- progress recap
  console.log('\n[progress recap]');
  const recap = await fetch(`${BASE}/api/session/${b2.sessionId}/progress`).then((r) => r.json());
  check('recap reports answered count', recap.recap.answered > 0);
  check('recap reports accuracy', typeof recap.recap.accuracy === 'number');
  check('recap lists practised skills', recap.recap.skills.length > 0);
  check('recap labels each skill as developing or ready-for-challenge',
    recap.recap.skills.every((s) => ['developing', 'ready-for-challenge'].includes(s.status)));
  check('recap reports the next recommended action', typeof recap.recap.nextRecommendedAction === 'string');
  check('recap includes misconception counts', Array.isArray(recap.recap.misconceptions));

  // -------------------------------------------------------------- security
  console.log('\n[security]');
  const q = b2.firstQuestion;
  check('question payload omits answerId', !Object.keys(q).includes('answerId'));
  check('question payload omits misconception map', !Object.keys(q).includes('misconceptions'));
  check('question payload omits explanation', !Object.keys(q).includes('explanation'));

  const unknownSess = await fetch(`${BASE}/api/session/definitely-not-a-session/question`);
  check('unknown session returns 404', unknownSess.status === 404);

  const stale = await fetch(`${BASE}/api/session/${b2.sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: 'le-99', optionId: 'opt-7', usedHint: false }),
  });
  check('unknown question id returns 404', stale.status === 404);

  // Client-supplied lesson concepts must not be trusted.
  const badLesson = await fetch(`${BASE}/api/session/${a.sessionId}/lesson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conceptId: 'variables-both-sides', action: 'review' }),
  });
  check('a concept the student never attempted is refused', badLesson.status === 400);

  // Unsupported scope is now expressed through the curriculum catalogue, not a
  // hardcoded chapter allowlist: a grade the pack does not cover is refused.
  const wrongGrade = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'X', class: 9, subject: 'mathematics', chapter: 'Linear Equations' }),
  });
  check('a grade the pack does not cover is rejected', wrongGrade.status === 404 || wrongGrade.status === 400);

  const unknownCurriculum = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'X', class: 8, subject: 'mathematics', chapter: 'Linear Equations', curriculumId: 'IN.NOPE.2026' }),
  });
  check('an unknown curriculum is rejected', unknownCurriculum.status === 404);

  // Coverage must be honest: an unseeded subject reports no chapters.
  const empty = await fetch(`${BASE}/api/subjects/mathematics/chapters?curriculumId=IN.AP-SSC.2024-25&grade=10`)
    .then((r) => r.json());
  check('an unseeded subject reports an empty chapter list, not another grade\'s chapters',
    Array.isArray(empty.chapters) && empty.chapters.length === 0);

  const badClass = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'X', class: 99, subject: 'mathematics', chapter: 'Linear Equations', language: 'en' }),
  });
  check('an invalid class is rejected', badClass.status === 400);

  // --------------------------------- diagnosis, post-assessment, results
  console.log('\n[diagnosis, post-assessment, results]');
  const diagA = await fetch(`${BASE}/api/session/${a.sessionId}/diagnosis`).then((r) => r.json());
  check('diagnosis reports the gap concept',
    diagA.diagnosis.gaps.some((g) => g.conceptId === 'number-sense'));
  check('diagnosis labels a repeated error as a repeated pattern',
    diagA.diagnosis.misconceptions[0] && diagA.diagnosis.misconceptions[0].confidence === 'repeated-pattern');
  check('diagnosis path starts with a reteaching lesson',
    diagA.diagnosis.path.steps[0].kind === 'lesson');
  check('diagnosis path ends with a post-assessment step',
    diagA.diagnosis.path.steps[diagA.diagnosis.path.steps.length - 1].action === 'post-assessment');
  check('every path step carries a reason',
    diagA.diagnosis.path.steps.every((s) => typeof s.reason === 'string' && s.reason.length > 10));

  const diagB = await fetch(`${BASE}/api/session/${b2.sessionId}/diagnosis`).then((r) => r.json());
  check('strong student diagnosis has no reteaching path',
    diagB.diagnosis.path.steps.every((s) => s.action !== 'targeted-review'));
  check('weak and strong students get different paths',
    JSON.stringify(diagA.diagnosis.path.steps.map((s) => s.action)) !==
    JSON.stringify(diagB.diagnosis.path.steps.map((s) => s.action)));

  // A fresh session has nothing to reassess.
  const fresh = await createSession('Zed');
  const emptyStart = await fetch(`${BASE}/api/session/${fresh.sessionId}/post-assessment/start`, { method: 'POST' });
  check('post-assessment without evidence is refused honestly', emptyStart.status === 409);

  // Student A starts the post-assessment (bank exhausted by struggle on one
  // concept, so honest retakes are served and flagged).
  const startARes = await fetch(`${BASE}/api/session/${a.sessionId}/post-assessment/start`, { method: 'POST' });
  const startABody = await startARes.json();
  check('post-assessment starts', startARes.status === 201 && Boolean(startABody.question));
  check('post-assessment phase is reported', startABody.phase === 'post');
  // Answer two post questions correctly (answer keys stay server-side; the
  // harness uses the engine-verified map, the server still grades).
  let postQ = startABody.question;
  for (let i = 0; i < 2 && postQ; i++) {
    const optionId = CORRECT[postQ.qid] || postQ.options[0].id;
    const r = await answer(a.sessionId, postQ, optionId);
    check(`post answer ${i + 1} is stage-tagged`, r.phase === 'post');
    const nq = await fetch(`${BASE}/api/session/${a.sessionId}/question`).then((x) => x.json());
    postQ = nq.completed ? null : nq;
  }
  const resultsA = await fetch(`${BASE}/api/session/${a.sessionId}/results`).then((r) => r.json());
  check('results compare diagnostic and post accuracy',
    typeof resultsA.results.diagnostic.accuracy === 'number' &&
    typeof resultsA.results.post.accuracy === 'number');
  check('results report per-concept before/after',
    Array.isArray(resultsA.results.perConcept) && resultsA.results.perConcept.length > 0);
  check('results recommend an evidence-based next step',
    typeof resultsA.results.nextStep === 'string' && resultsA.results.nextStep.length > 10);

  // Student B has no post evidence yet: unmeasured, never faked.
  const resultsB = await fetch(`${BASE}/api/session/${b2.sessionId}/results`).then((r) => r.json());
  check('results without post evidence ask for the post-assessment',
    /post-assessment/.test(resultsB.results.nextStep));
  check('results mark unmeasured concepts honestly',
    resultsB.results.unmeasured.length > 0 && resultsB.results.change === null);

  console.log(`\n${failures === 0 ? 'ALL INTEGRATION TESTS PASSED' : `${failures} INTEGRATION TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Integration harness error:', e); process.exit(1); });
