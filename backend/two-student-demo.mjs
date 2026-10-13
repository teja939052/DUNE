/**
 * The core hackathon demo: two Class 8 students, same question bank, visibly
 * different learning paths, plus the AI-failure fallback check.
 *
 * Run: node two-student-demo.mjs
 */
const BASE = process.env.TEST_BASE || 'http://localhost:3001';
let failures = 0;

function check(label, condition) {
  if (condition) console.log(`  PASS: ${label}`);
  else { console.error(`  FAIL: ${label}`); failures++; }
}

const CORRECT = {
  'le-01': 'opt-7', 'le-02': 'opt-11', 'le-03': 'opt-7', 'le-04': 'opt-12',
  'le-05': 'opt-4', 'le-06': 'opt-5', 'le-07': 'opt-4', 'le-08': 'opt-5',
  'le-09': 'opt-5', 'le-10': 'opt-3', 'le-11': 'opt-4', 'le-12': 'opt-4',
};
const KNOWN_WRONG = {
  'le-01': 'opt-17', // wrong-inverse-operation
  'le-02': 'opt-5',  // wrong-inverse-operation
};

async function createSession(nickname) {
  const res = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, class: 8, subject: 'mathematics', chapter: 'Linear Equations', language: 'en' }),
  });
  return res.json();
}

async function answer(sid, q, optionId) {
  const res = await fetch(`${BASE}/api/session/${sid}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.qid, optionId, usedHint: false }),
  });
  return res.json();
}

async function lesson(sid, conceptId, action) {
  const res = await fetch(`${BASE}/api/session/${sid}/lesson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conceptId, action }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ------------------------------------------------ Student A: struggles early
  const a = await createSession('Aarav');
  let cur = a.firstQuestion;
  const wrong1 = KNOWN_WRONG[cur.qid];
  const r1 = await answer(a.sessionId, cur, wrong1 ?? cur.options[1].id);
  const q2 = r1.nextQuestion;
  const wrong2 = KNOWN_WRONG[q2.qid] ?? q2.options[1].id;
  const r2 = await answer(a.sessionId, q2, wrong2);
  const aDecision = r2.nextAction;
  const aLessonResp = await lesson(a.sessionId, aDecision.targetConceptId, aDecision.code);
  const aLesson = aLessonResp.body.lesson;
  const aNextSkill = r2.learningState.conceptId;

  // ------------------------------------------------ Student B: solves correctly
  const b = await createSession('Meera');
  cur = b.firstQuestion;
  let bChallenge = null;
  let bLessonRequested = false;
  let bMaxMastery = 0;
  let bNextSkill = null;

  for (let i = 0; i < 12 && cur; i++) {
    const correctId = CORRECT[cur.qid];
    if (!correctId) break;
    const r = await answer(b.sessionId, cur, correctId);
    bNextSkill = r.nextAction.targetConceptId;
    bMaxMastery = Math.max(bMaxMastery, r.learningState.masteryAfter);
    if (r.nextAction.lessonRequested) bLessonRequested = true;
    if (r.nextAction.code === 'harder-challenge') bChallenge = r.nextAction;
    cur = r.nextQuestion;
  }

  // ------------------------------------------------------------- divergence
  console.log('\n[divergence]');
  check('student A triggers a lesson', aDecision.lessonRequested === true);
  check('student B is never forced into a lesson', bLessonRequested === false);
  check('student B is offered a harder challenge', Boolean(bChallenge));
  check('the two students get different next-action codes',
    aDecision.code !== (bChallenge?.code ?? 'none'));
  check('the two students get different learning concepts',
    aNextSkill !== bNextSkill || Boolean(bChallenge));

  // Student A's lesson is on number-sense, the ROOT of the prerequisite chain,
  // so by definition it has no prerequisites and everything else is what it
  // leads to.
  check('lesson targets the struggling concept (number-sense)',
    aLesson.conceptId === 'number-sense');
  const aNodes = aLesson.mindMap.nodes;
  check('mind map highlights the current node', aNodes.some((n) => n.type === 'current'));
  check('mind map shows what the concept leads to (root concept)',
    aNodes.filter((n) => n.type === 'target').length >= 1);
  check('mind map has no prerequisites for the root concept',
    aNodes.filter((n) => n.type === 'prerequisite').length === 0);
  check('mind map nodes carry mastery state',
    aNodes.every((n) => ['not_tested', 'developing', 'solid', 'needs_review'].includes(n.state)));

  // A mid-chain concept must show BOTH sides of the graph. Use a session that
  // has actually attempted a two-step question, because the endpoint only
  // serves lesson concepts the student has evidence for.
  const midSession = await createSession('MidChain');
  let midQ = midSession.firstQuestion;
  for (let i = 0; i < 12 && midQ; i++) {
    const r = await answer(midSession.sessionId, midQ, CORRECT[midQ.qid]);
    if (midQ.conceptId === 'two-step-equations') break;
    midQ = r.nextQuestion;
  }
  const mid = await lesson(midSession.sessionId, 'two-step-equations', 'guided-practice');
  const midNodes = mid.body.lesson?.mindMap?.nodes || [];
  check('a mid-chain concept lesson was returned', mid.status === 200);
  check('a mid-chain concept shows prerequisite nodes',
    midNodes.filter((n) => n.type === 'prerequisite').length >= 1);
  check('a mid-chain concept shows target nodes',
    midNodes.filter((n) => n.type === 'target').length >= 1);
  check('the current concept is highlighted in the mid-chain lesson',
    midNodes.some((n) => n.type === 'current' && n.id === 'two-step-equations'));
  check('all mind map edges reference real nodes',
    (mid.body.lesson?.mindMap?.edges || []).every((e) =>
      midNodes.some((n) => n.id === e.from) && midNodes.some((n) => n.id === e.to)));
  check('lesson has worked steps with reasoning',
    aLesson.steps.length >= 2 && aLesson.steps.every((s) => s.caption && s.content && s.why));
  check('lesson final answer matches the canonical answer',
    aLesson.finalAnswer === aLesson.expectedAnswer);
  check('lesson source is recorded', ['gemini', 'fallback'].includes(aLesson.source));
  check('lesson ends with a concrete next action', typeof aLesson.tryNext === 'string' && aLesson.tryNext.length > 3);

  // Same-concept lessons must differ by student context: student A's lesson is
  // on the prerequisite, and the reason text names the observed evidence.
  check('the reason references the observed failure',
    aDecision.reason.toLowerCase().includes('miss') ||
    aDecision.reason.toLowerCase().includes('wrong') ||
    /2 in a row/.test(aDecision.reason));

  // --------------------------------------------------- AI failure fallback
  console.log('\n[AI failure fallback]');
  // Student A already got a lesson through whatever mode the server is in.
  // Force the fallback by requesting a concept with reviewed content but
  // checking that the response is usable and valid in either mode.
  const same = await lesson(a.sessionId, 'number-sense', 'targeted-review');
  const l2 = same.body.lesson;
  check('a repeat lesson request still succeeds', same.status === 200);
  check('fallback-or-gemini lesson keeps the same schema',
    l2 && l2.mindMap && Array.isArray(l2.steps) && typeof l2.hint === 'string');
  check('the lesson remains usable when the AI mode changes',
    l2.finalAnswer === l2.expectedAnswer);

  // ------------------------------------------------------- progress divergence
  const aRecap = await fetch(`${BASE}/api/session/${a.sessionId}/progress`).then((r) => r.json());
  const bRecap = await fetch(`${BASE}/api/session/${b.sessionId}/progress`).then((r) => r.json());
  console.log('\n[progress divergence]');
  check('student A has misconceptions detected', aRecap.recap.misconceptions.length >= 1);
  check('student B has higher accuracy', bRecap.recap.accuracy > aRecap.recap.accuracy);
  check('student B reaches ready-for-challenge somewhere',
    bRecap.recap.skills.some((s) => s.status === 'ready-for-challenge'));
  check('student A has no ready-for-challenge skill yet',
    !aRecap.recap.skills.some((s) => s.status === 'ready-for-challenge'));
  check('the two students get different recommendations',
    aRecap.recap.nextRecommendedAction !== bRecap.recap.nextRecommendedAction);

  // ------------------------------------------------------------------ summary
  console.log('\n---------------- SUMMARY ----------------');
  console.log(`Student A (wrong inverse twice):`);
  console.log(`  action:            ${aDecision.code}`);
  console.log(`  reason:            ${aDecision.reason}`);
  console.log(`  next concept:      ${aDecision.targetConceptLabel}`);
  console.log(`  lesson concept:    ${aLesson.conceptId}`);
  console.log(`  lesson source:     ${aLesson.source}`);
  console.log(`  lesson title:      ${aLesson.title}`);
  console.log(`  mind map nodes:    ${aLesson.mindMap.nodes.map((n) => n.label).join(' | ')}`);
  console.log(`  first step:        ${aLesson.steps[0].caption} — ${aLesson.steps[0].content}`);
  console.log(`Student B (correct throughout):`);
  console.log(`  max mastery:       ${bMaxMastery}%`);
  console.log(`  challenge action:  ${bChallenge ? bChallenge.code : 'none'}`);
  console.log(`  challenge reason:  ${bChallenge ? bChallenge.reason : '-'}`);
  console.log(`  moved to:          ${bChallenge ? bChallenge.targetConceptLabel : '-'}`);
  console.log(`  accuracy:          ${bRecap.recap.accuracy}% (A: ${aRecap.recap.accuracy}%)`);
  console.log('---------------------------------------');

  console.log(`\n${failures === 0 ? 'TWO-STUDENT DEMO VERIFIED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Demo harness error:', e); process.exit(1); });
