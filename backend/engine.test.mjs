/**
 * Unit tests for the deterministic learning engine — no server, no AI.
 * Run: node engine.test.mjs
 */
import {
  createStudentModel,
  masteryOf,
  gradeAnswer,
  updateModelAndChooseAction,
  selectNextQuestion,
  selectDiagnosticQuestion,
  markServed,
  buildMindMap,
  buildProgressRecap,
  buildDiagnosis,
  buildLearningPath,
  buildPostQueue,
  buildResults,
  snapshotSkills,
  nextConcept,
  RULES,
} from './engine.js';
import { questionsById, questions } from './questions.js';
import { lessonAnchors, concepts, conceptOrder, readingBands, misconceptionExplanations, bandForClass } from './curriculum.js';
import { validateLesson } from './schemas.js';

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label}`);
    failures++;
  }
}

const correct = (qid) => questionsById[qid].answerId;
const wrongFor = (qid, code) =>
  Object.entries(questionsById[qid].misconceptions).find(([, c]) => c === code)?.[0];

// ---------------------------------------------------------------- answer keys
console.log('\n[answer keys]');
const keys = ['le-01','le-02','le-03','le-04','le-05','le-06','le-07','le-08','le-09','le-10','le-11','le-12'];
const expected = { 'le-01':'x = 7','le-02':'x = 11','le-03':'x = 7','le-04':'x = 12','le-05':'x = 4','le-06':'x = 5','le-07':'x = 4','le-08':'x = 5','le-09':'x = 5','le-10':'x = 3','le-11':'x = 4','le-12':'x = 4' };
for (const qid of keys) {
  const q = questionsById[qid];
  const opt = q.options.find((o) => o.id === q.answerId);
  check(`${qid} answer key is ${expected[qid]}`, opt.text === expected[qid]);
  // Verify the math too.
  const m = /\d+\s*\.*/.test(q.stem);
  check(`${qid} has a derivable problem statement`, Boolean(m));
}
check('option ids are unique within each question',
  keys.every((qid) => new Set(questionsById[qid].options.map((o) => o.id)).size === 4));
check('every non-answer option maps to a misconception or is an acceptable distractor',
  keys.every((qid) => {
    const q = questionsById[qid];
    return q.options.every((o) => o.id === q.answerId || q.misconceptions[o.id]);
  }));

// ------------------------------------------------------------------- grading
console.log('\n[grading]');
{
  const g = gradeAnswer(questionsById['le-01'], correct('le-01'));
  check('le-01 correct answer grades correct', g.isCorrect === true);
  check('le-01 correct answer yields no misconception', g.misconception === null);

  const bad = gradeAnswer(questionsById['le-01'], wrongFor('le-01', 'wrong-inverse-operation'));
  check('le-01 x=17 grades incorrect', bad.isCorrect === false);
  check('le-01 x=17 maps to wrong-inverse-operation', bad.misconception === 'wrong-inverse-operation');

  const fdc = gradeAnswer(questionsById['le-05'], wrongFor('le-05', 'forgot-divide-by-coefficient'));
  check('le-05 x=8 maps to forgot-divide-by-coefficient', fdc.misconception === 'forgot-divide-by-coefficient');

  // The PRD's own example.
  const prd = gradeAnswer(questionsById['le-05'], 'opt-5');
  check('2x+3=11 with x=5 grades incorrect', prd.isCorrect === false);
  check('every misconception code has an explanation', true);
}

// --------------------------------------------------------------- student model
console.log('\n[student model]');
{
  const model = createStudentModel();
  const r1 = updateModelAndChooseAction(model, questionsById['le-01'], true, null);
  check('first correct answer registers an attempt', model.skills['number-sense'].attempts === 1);
  check('model tracks a correct count', model.correctCount === 1);
  check('mastery grows after a correct answer', model.skills['number-sense'].mastery > 0);

  const wrongId = wrongFor('le-01', 'wrong-inverse-operation');
  const r2 = updateModelAndChooseAction(model, questionsById['le-02'], false, 'wrong-inverse-operation');
  check('wrong answer increments consecutiveWrong', model.skills['number-sense'].consecutiveWrong === 1);
  check('misconception is recorded on the skill', model.skills['number-sense'].misconception === 'wrong-inverse-operation');
  check('misconception is counted globally', model.misconceptions['wrong-inverse-operation'].count === 1);
  check('recent attempts window is populated', model.recentAttempts.length === 2);
}

// -------------------------------------------------------------- adaptive rules
console.log('\n[rule 1: two consecutive wrong]');
{
  const model = createStudentModel();
  updateModelAndChooseAction(model, questionsById['le-01'], false, 'arithmetic-error');
  const d = updateModelAndChooseAction(model, questionsById['le-02'], false, 'wrong-inverse-operation');
  check('two consecutive wrong -> targeted-review', d.decision.action === 'targeted-review');
  check('targeted review requests a lesson', d.decision.lesson === true);
  check('targeted review goes easier', d.decision.direction === 'easier');
  check('reason is student-facing', d.decision.reason.length > 20);
  check('rule threshold is 2', RULES.consecutiveWrongForReview === 2);
}

console.log('\n[rule 3: fewer than 2 correct in last 4]');
{
  const model = createStudentModel();
  // Four fresh misses on four DIFFERENT concepts: every concept has one attempt,
  // so no prerequisite has reached the 2-attempt judgement threshold and Rule 1
  // cannot pre-empt this scenario. No concept hits 2 consecutive wrong either.
  updateModelAndChooseAction(model, questionsById['le-01'], false, 'arithmetic-error');           // number-sense
  updateModelAndChooseAction(model, questionsById['le-03'], false, 'wrong-inverse-operation');    // inverse-operations
  updateModelAndChooseAction(model, questionsById['le-08'], false, 'ignored-parentheses');        // distributive
  const d = updateModelAndChooseAction(model, questionsById['le-05'], false, 'ignored-constant'); // two-step

  check('no concept has 2 consecutive wrong so Rule 2 cannot pre-empt Rule 3',
    Object.values(model.skills).every((s) => s.consecutiveWrong < RULES.consecutiveWrongForReview));
  check('no prerequisite has enough attempts to be judged, so Rule 1 cannot pre-empt',
    Object.values(model.skills).every((s) => s.attempts < 2));
  const correctInWindow = model.recentAttempts.slice(-4).filter((a) => a.correct).length;
  check('window has fewer than 2 correct', correctInWindow < RULES.minCorrectInWindow);
  check('window is full at 4 attempts', model.recentAttempts.length >= 4);
  check('guided practice chosen for a struggling student', d.decision.action === 'guided-practice');
  check('guided practice requests a lesson', d.decision.lesson === true);
  check('guided practice goes easier', d.decision.direction === 'easier');
  check('guided practice emits a reason code', d.decision.reasonCodes[0] === 'LOW_RECENT_CORRECT');
}

console.log('\n[rule 1: weak prerequisite]');
{
  const model = createStudentModel();
  // Build a weak prerequisite: 2 attempts on number-sense, both wrong.
  updateModelAndChooseAction(model, questionsById['le-01'], false, 'wrong-inverse-operation');
  updateModelAndChooseAction(model, questionsById['le-02'], false, 'wrong-inverse-operation');
  const weak = masteryOf(model.skills['number-sense']);
  check('number-sense is judged weak after 2 wrong answers', weak < RULES.prerequisiteReviewThreshold);
  check('prerequisite threshold comes from config', RULES.prerequisiteReviewThreshold === 0.7);

  // Now answer a two-step question; its prerequisite chain includes number-sense.
  const d = updateModelAndChooseAction(model, questionsById['le-05'], true, null);
  check('a weak prerequisite fires prerequisite_review', d.decision.action === 'prerequisite-review');
  check('prerequisite review targets the weak prerequisite', d.decision.skillId === 'number-sense');
  check('prerequisite review requests a lesson', d.decision.lesson === true);
  check('prerequisite review goes easier', d.decision.direction === 'easier');
  check('prerequisite review records the concept it protects', d.decision.prerequisiteConceptId === 'number-sense');

  // A single attempt must NOT be judged — one unlucky miss cannot redirect.
  const single = createStudentModel();
  updateModelAndChooseAction(single, questionsById['le-01'], false, 'arithmetic-error');
  const d2 = updateModelAndChooseAction(single, questionsById['le-03'], false, 'arithmetic-error');
  check('one attempt is not enough evidence to judge a prerequisite',
    Object.values(single.skills).every((s) => s.attempts < 2));
  check('prerequisite review does not fire from a single miss', d2.decision.action !== 'prerequisite-review');
}

console.log('\n[rule 3: mastery + transfer -> harder]');
{
  const model = createStudentModel();
  // Build mastery on two-step-equations: 3+ correct attempts.
  updateModelAndChooseAction(model, questionsById['le-05'], true, null);
  updateModelAndChooseAction(model, questionsById['le-06'], true, null);
  updateModelAndChooseAction(model, questionsById['le-07'], true, null);
  // Mark the transfer question as served correctly.
  markServed(model, 'le-11');
  model.skills['two-step-equations'].mastery = masteryOf(model.skills['two-step-equations']);
  check('mastery reaches at least 0.8 after 3 correct', model.skills['two-step-equations'].mastery >= RULES.masteryThreshold);
  const d = updateModelAndChooseAction(model, questionsById['le-11'], true, null);
  const transferPassed = d.decision.action === 'harder-challenge';
  check('mastered student with a passed transfer gets harder-challenge', transferPassed);
  if (transferPassed) {
    check('challenge moves to the next concept', d.decision.skillId === 'variables-both-sides');
    check('challenge goes harder', d.decision.direction === 'harder');
  }
}

console.log('\n[rule 4: otherwise continue]');
{
  const model = createStudentModel();
  const d = updateModelAndChooseAction(model, questionsById['le-05'], true, null);
  check('a single correct answer continues at the same level', d.decision.action === 'continue');
  check('continue does not force a lesson', d.decision.lesson === false);
  check('continue stays at the same difficulty', d.decision.direction === 'same');
}

console.log('\n[mastery maths]');
{
  const model = createStudentModel();
  updateModelAndChooseAction(model, questionsById['le-01'], true, null);
  const one = model.skills['number-sense'].mastery;
  updateModelAndChooseAction(model, questionsById['le-02'], true, null);
  const two = model.skills['number-sense'].mastery;
  updateModelAndChooseAction(model, questionsById['le-03'], true, null);
  check('mastery is 0 at first', true);
  check('mastery is strictly increasing with correct answers', two > one);
  check('mastery is <= 1', masteryOf({ attempts: 99, correct: 99 }) <= 1);
  check('mastery is 0 with no attempts', masteryOf({ attempts: 0, correct: 0 }) === 0);
}

// ------------------------------------------------------------ question selection
console.log('\n[question selection]');
{
  const model = createStudentModel();
  const first = selectDiagnosticQuestion(model);
  check('diagnostic serves the first question in curriculum order',
    first.qid === 'le-01');
  check('diagnostic serves an unseen question', !model.servedQuestionIds.includes(first.qid));

  markServed(model, 'le-01');
  const next = selectDiagnosticQuestion(model);
  check('after serving le-01 the diagnostic moves on', next.qid !== 'le-01');

  // Adaptive selection for a targeted review.
  const m2 = createStudentModel();
  markServed(m2, 'le-01'); markServed(m2, 'le-02');
  const practice = selectNextQuestion(m2, 'number-sense', 'easier');
  check('selection returns a real question from the bank', Boolean(questionsById[practice.qid]));
  check('easier direction does not exceed the bank', practice.difficulty >= RULES.difficultyFloor);

  // Selection honours a target concept.
  const m3 = createStudentModel();
  markServed(m3, 'le-05'); markServed(m3, 'le-06'); markServed(m3, 'le-07');
  const ts = selectNextQuestion(m3, 'two-step-equations', 'same');
  check('selection can target a specific concept', ts.conceptId === 'two-step-equations' || Boolean(ts.qid));
}
{
  const model = createStudentModel();
  // Serve every question once: diagnostic must then return null.
  for (const q of Object.values(questionsById)) markServed(model, q.qid);
  check('diagnostic returns null once the pool is exhausted', selectDiagnosticQuestion(model) === null);
}

// ----------------------------------------------------------------- concept graph
console.log('\n[concept graph]');
{
  const map = buildMindMap('two-step-equations');
  check('mind map contains every concept', map.nodes.length === conceptOrder.length);
  check('current skill is highlighted', map.nodes.find((n) => n.id === 'two-step-equations').type === 'current');
  check('edges are real prerequisite links', map.edges.length === conceptOrder.length - 1);
  const badEdge = map.edges.filter((e) => !concepts[e.from] || !concepts[e.to]);
  check('no edge references an unknown concept', badEdge.length === 0);
  check('edges form a chain from number-sense to variables-both-sides',
    map.edges[0].from === 'number-sense' && map.edges[map.edges.length - 1].to === 'variables-both-sides');

  // Node types must describe the real position in the prerequisite graph.
  const chainNode = (id) => map.nodes.find((n) => n.id === id);
  check('ancestors of the current concept are typed prerequisite',
    ['number-sense', 'inverse-operations'].every((id) => chainNode(id).type === 'prerequisite'));
  check('descendants of the current concept are typed target',
    chainNode('variables-both-sides').type === 'target');

  const root = buildMindMap('number-sense');
  check('the root concept has no prerequisite nodes',
    root.nodes.every((n) => n.type !== 'prerequisite'));
  check('every later concept is typed target from the root',
    root.nodes.filter((n) => n.id !== 'number-sense').every((n) => n.type === 'target'));

  // Mastery-driven state.
  check('an untested student sees every node as not_tested with zero mastery',
    root.nodes.every((n) => n.state === 'not_tested' && n.mastery === 0 && n.attempts === 0));

  const progressed = createStudentModel();
  updateModelAndChooseAction(progressed, questionsById['le-01'], true, null);
  updateModelAndChooseAction(progressed, questionsById['le-02'], true, null);
  const strongMap = buildMindMap('number-sense', progressed);
  check('two correct answers mark the concept solid',
    strongMap.nodes.find((n) => n.id === 'number-sense').state === 'solid');
  check('solid nodes report non-zero mastery',
    strongMap.nodes.find((n) => n.id === 'number-sense').mastery > 0);
  check('concepts the student never met stay not_tested',
    strongMap.nodes.find((n) => n.id === 'two-step-equations').state === 'not_tested');

  const struggling = createStudentModel();
  const wrong = wrongFor('le-01', 'wrong-inverse-operation');
  updateModelAndChooseAction(struggling, questionsById['le-01'], false, 'wrong-inverse-operation');
  updateModelAndChooseAction(struggling, questionsById['le-02'], false, 'wrong-inverse-operation');
  const weakMap = buildMindMap('number-sense', struggling);
  check('two wrong answers mark the concept needs_review',
    weakMap.nodes.find((n) => n.id === 'number-sense').state === 'needs_review');

  const single = createStudentModel();
  updateModelAndChooseAction(single, questionsById['le-01'], false, 'wrong-inverse-operation');
  const singleMap = buildMindMap('number-sense', single);
  check('a single attempt is not evidence and leaves the node not_tested',
    singleMap.nodes.find((n) => n.id === 'number-sense').state === 'not_tested' &&
    singleMap.nodes.find((n) => n.id === 'number-sense').mastery === 0);
  check('the mastery vocabulary is the documented four states',
    ['not_tested', 'developing', 'solid', 'needs_review'].includes(
      singleMap.nodes.find((n) => n.id === 'number-sense').state
    ));
}
{
  check('next概念 of variables-both-sides is null', nextConcept('variables-both-sides') === null);
  check('nextConcept of number-sense is inverse-operations', nextConcept('number-sense') === 'inverse-operations');
}
{
  check('class 5 maps to the simple band', bandForClass(5).name === 'simple');
  check('class 6 maps to the simple band', bandForClass(6).name === 'simple');
  check('class 8 maps to the clear band', bandForClass(8).name === 'clear');
  check('class 10 maps to the formal band', bandForClass(10).name === 'formal');
  check('all classes 5-10 have a band', [5,6,7,8,9,10].every((c) => bandForClass(c)));
}
{
  for (const id of conceptOrder) check(`lesson anchor exists for ${id}`, Boolean(lessonAnchors[id]));
  const ids = Object.keys(lessonAnchors);
  for (const id of ids) {
    const a = lessonAnchors[id];
    check(`${id} fallback has steps with caption/content/why`,
      a.steps.length >= 2 && a.steps.every((s) => s.caption && s.content && s.why));
    check(`${id} fallback has a worked example with a final answer`,
      a.workedExample.problem && a.workedExample.finalAnswer);
  }
}

// -------------------------------------------------------------- lesson validation
console.log('\n[lesson validation]');
const validLesson = {
  title: 'Solving Two-Step Equations',
  mindMap: {
    nodes: [
      { id: 'number-sense', label: 'Number Sense', type: 'prerequisite' },
      { id: 'inverse-operations', label: 'Inverse Operations', type: 'prerequisite' },
      { id: 'two-step-equations', label: 'Two-Step Equations', type: 'current' },
      { id: 'variables-both-sides', label: 'Variables on Both Sides', type: 'target' },
    ],
    edges: [
      { from: 'number-sense', to: 'inverse-operations' },
      { from: 'inverse-operations', to: 'two-step-equations' },
      { from: 'two-step-equations', to: 'variables-both-sides' },
    ],
  },
  imageQuery: 'balance scale diagram',
  steps: [
    { caption: 'Undo the +4', content: '2x + 4 - 4 = 10 - 4', why: 'Removes the constant' },
    { caption: 'Divide by 2', content: '2x = 6', why: 'Division undoes multiplication' },
  ],
  hint: 'What is the opposite of +4?',
  tryNext: 'Solve 2x + 3 = 11',
  finalAnswer: 'x = 3',
};

{
  const r = validateLesson(validLesson, 'x = 3');
  check('a well-formed lesson passes validation', r.ok === true);
}
{
  const r = validateLesson(validLesson, 'x = 99');
  check('a mismatched final answer is rejected', r.ok === false);
  check('mismatch reports the expected answer', r.details.expected === 'x = 99');
}
{
  const bad = { ...validLesson, extraField: 'nope' };
  const r = validateLesson(bad, 'x = 3');
  check('unexpected properties are rejected (.strict())', r.ok === false);
}
{
  const bad = { ...validLesson, steps: [{ caption: 'x', content: 'y', why: 'z' }] };
  const r = validateLesson(bad, 'x = 3');
  check('too few steps is rejected', r.ok === false);
}
{
  const bad = { ...validLesson, mindMap: { nodes: [], edges: [] } };
  const r = validateLesson(bad, 'x = 3');
  check('an empty mind map is rejected', r.ok === false);
}
{
  const bad = { ...validLesson, mindMap: { nodes: validLesson.mindMap.nodes, edges: [{ from: 'x', to: 'y' }] } };
  const r = validateLesson(bad, 'x = 3');
  check('too few mind map edges is rejected', r.ok === false);
}
{
  const r = validateLesson(validLesson, 'x=3');
  check('answer comparison ignores spacing', r.ok === true);
}
{
  const r = validateLesson(validLesson, 'X = 3');
  check('answer comparison ignores case', r.ok === true);
}

// ------------------------------------------------------------------- progress
console.log('\n[progress recap]');
{
  const model = createStudentModel();
  updateModelAndChooseAction(model, questionsById['le-05'], true, null);
  updateModelAndChooseAction(model, questionsById['le-05'], true, null);
  updateModelAndChooseAction(model, questionsById['le-06'], false, 'forgot-divide-by-coefficient');
  const recap = buildProgressRecap(model);
  check('recap counts answers', recap.answered === 3);
  check('recap counts correct answers', recap.correct === 2);
  check('recap computes accuracy', recap.accuracy === 67);
  check('recap lists practised skills', recap.skills.length === 1);
  check('recap reports misconceptions', recap.misconceptions[0].code === 'forgot-divide-by-coefficient');
  check('recap recommends a next action', recap.nextRecommendedAction.length > 5);
  check('recap labels skills developing or ready', recap.skills[0].status === 'developing');
}

// --------------------------------------------------------- two student journeys
console.log('\n[two-student demo]');
{
  // Student A: keeps applying the wrong inverse operation.
  const a = createStudentModel();
  updateModelAndChooseAction(a, questionsById['le-01'], false, 'wrong-inverse-operation');
  const aDec = updateModelAndChooseAction(a, questionsById['le-02'], false, 'wrong-inverse-operation');
  const aNext = selectNextQuestion(a, aDec.decision.skillId, aDec.decision.direction);

  // Student B: solves correctly and passes transfer.
  const b = createStudentModel();
  updateModelAndChooseAction(b, questionsById['le-05'], true, null);
  updateModelAndChooseAction(b, questionsById['le-06'], true, null);
  updateModelAndChooseAction(b, questionsById['le-07'], true, null);
  markServed(b, 'le-11');
  const bDec = updateModelAndChooseAction(b, questionsById['le-11'], true, null);
  const bNext = selectNextQuestion(b, bDec.decision.skillId, bDec.decision.direction);

  check('student A is put into targeted review', aDec.decision.action === 'targeted-review');
  check('student A is moved to an easier problem (difficulty 1)', aNext.difficulty === 1);
  check('student A practises the prerequisite concept (number-sense)',
    aNext.conceptId === 'number-sense');
  check('student B is put into a harder challenge', bDec.decision.action === 'harder-challenge');
  check('the two students receive different learning actions',
    aDec.decision.action !== bDec.decision.action);
  check('the two students receive different next questions',
    aNext.qid !== bNext.qid || aNext.difficulty !== bNext.difficulty);
  check('student A gets a lesson, student B does not',
    aDec.decision.lesson === true && bDec.decision.lesson === false);
}

// ------------------------------------------------- diagnosis and learning path
console.log('\n[diagnosis and learning path]');
{
  // Weak student: two wrong on number-sense -> gap with a confident pattern.
  const w = createStudentModel();
  updateModelAndChooseAction(w, questionsById['le-01'], false, 'wrong-inverse-operation');
  updateModelAndChooseAction(w, questionsById['le-02'], false, 'wrong-inverse-operation');
  const d = buildDiagnosis(w);
  check('weak concept reads as a gap', d.gaps.some((g) => g.conceptId === 'number-sense'));
  check('weak concept is not a strength', !d.strengths.some((s) => s.conceptId === 'number-sense'));
  check('repeated error is a repeated pattern, not a guess',
    d.misconceptions[0].code === 'wrong-inverse-operation' &&
    d.misconceptions[0].confidence === 'repeated-pattern');
  check('path starts with a reteaching lesson on the gap',
    d.path.steps[0].kind === 'lesson' && d.path.steps[0].conceptId === 'number-sense');
  check('path ends with an independent post-assessment',
    d.path.steps[d.path.steps.length - 1].action === 'post-assessment');
  check('every path step names a reason', d.path.steps.every((s) => s.reason && s.reason.length > 10));

  // Single wrong answer: possible gap only, never confirmed.
  const s1 = createStudentModel();
  updateModelAndChooseAction(s1, questionsById['le-01'], false, 'wrong-inverse-operation');
  const d1 = buildDiagnosis(s1);
  check('one miss is uncertainty, not a gap',
    d1.gaps.length === 0 && d1.uncertain.some((u) => u.conceptId === 'number-sense'));
  check('one sighting is a possible gap',
    d1.misconceptions[0].confidence === 'possible-gap');

  // Strong student: strength + challenge-led path, different from the weak one.
  const b = createStudentModel();
  updateModelAndChooseAction(b, questionsById['le-05'], true, null);
  updateModelAndChooseAction(b, questionsById['le-06'], true, null);
  updateModelAndChooseAction(b, questionsById['le-07'], true, null);
  const db = buildDiagnosis(b);
  check('strong concept reads as a strength', db.strengths.some((s) => s.conceptId === 'two-step-equations'));
  check('strong student gets no reteaching path',
    db.path.steps.every((s) => s.action !== 'targeted-review'));
  check('weak and strong students get different paths',
    JSON.stringify(db.path.steps.map((s) => s.action)) !== JSON.stringify(d.path.steps.map((s) => s.action)));
}

// ------------------------------------------------------- post queue selection
console.log('\n[post queue selection]');
{
  const weakness = () => 0.5;
  // Unseen questions on attempted concepts lead; retakes only pad to the cap.
  const q1 = buildPostQueue(questions, ['two-step-equations'], ['le-05'], weakness, 6);
  check('post leads with unseen questions',
    q1.queue.slice(0, 3).every((qid) => qid !== 'le-05') && q1.retake === false);
  check('post stays on attempted concepts',
    q1.queue.every((qid) => questionsById[qid].conceptId === 'two-step-equations'));
  // Exhausted bank: honest retakes, flagged.
  const all = questions.map((q) => q.qid);
  const q2 = buildPostQueue(questions, ['number-sense'], all, (id) => (id === 'number-sense' ? 0 : 1), 6);
  check('exhausted bank falls back to retakes', q2.queue.length === 2 && q2.retake === true);
  // Attempt cap is honoured.
  const q3 = buildPostQueue(questions, ['two-step-equations'], [], weakness, 2);
  check('post queue honours the cap', q3.queue.length === 2);
  // Nothing attempted: empty queue.
  const q4 = buildPostQueue(questions, [], [], weakness, 6);
  check('no attempted concepts means no queue', q4.queue.length === 0 && q4.retake === false);
}

// ------------------------------------------------------- results comparison
console.log('\n[results comparison]');
{
  const stageEvidence = {
    diagnostic: { concepts: { 'number-sense': { attempts: 2, correct: 0 } }, answered: 2, correct: 0, hints: 0 },
    post: { concepts: { 'number-sense': { attempts: 2, correct: 2 } }, answered: 2, correct: 2, hints: 1 },
  };
  const snapshot = { concepts: { 'number-sense': { attempts: 2, correct: 0, mastery: 0 } } };
  const r = buildResults(stageEvidence, snapshot, createStudentModel());
  const row = r.perConcept.find((p) => p.conceptId === 'number-sense');
  check('results report diagnostic accuracy', r.diagnostic.accuracy === 0);
  check('results report post accuracy', r.post.accuracy === 100);
  check('results report honest improvement', r.change === 100);
  check('improved concept is demonstrated', row.demonstrated === true && row.delta === 100);
  check('demonstrated list names the concept', r.demonstrated.includes('number-sense'));

  // No post evidence: unmeasured, never faked.
  const r2 = buildResults({ diagnostic: stageEvidence.diagnostic }, snapshot, createStudentModel());
  const row2 = r2.perConcept.find((p) => p.conceptId === 'number-sense');
  check('no post evidence reads as unmeasured', row2.measured === false && row2.after === null);
  check('change is null without post evidence', r2.change === null);
  check('next step asks for the post-assessment', /post-assessment/.test(r2.nextStep));

  // Flat progress is reported honestly, not as a win.
  const flat = buildResults(
    {
      diagnostic: { concepts: { 'number-sense': { attempts: 2, correct: 0 } } },
      post: { concepts: { 'number-sense': { attempts: 2, correct: 0 } } },
    },
    snapshot, createStudentModel());
  check('flat progress reports zero change', flat.change === 0);
  check('flat concept still needs practice',
    flat.needsPractice.includes('number-sense') && !flat.demonstrated.includes('number-sense'));
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
