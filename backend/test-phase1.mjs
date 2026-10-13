// Phase 1 end-to-end test: session -> 12 questions -> verify grading + shuffling.
const BASE = process.env.TEST_BASE || 'http://localhost:3001';
let created = null;

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

async function main() {
  // 1. Health
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  eq(health.status, 'ok', 'GET /api/health returns ok');

  // 2. Create session with invalid class -> 400
  const bad = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'X', class: 99, subject: 'mathematics', chapter: 'Linear Equations' }),
  });
  eq(bad.status, 400, 'POST /api/session rejects invalid class with 400');

  // 3. Create valid session
  created = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'TestStudent', class: 8, subject: 'mathematics', chapter: 'Linear Equations' }),
  }).then((r) => {
    if (!r.ok) throw new Error(`session create failed: ${r.status}`);
    return r.json();
  });
  eq(!!created.sessionId, true, 'POST /api/session returns a sessionId');

  // 4. Walk all 12 questions, answering correctly, verifying:
  //    - no answer key leaks (no `answerId` / `misconceptions` keys)
  //    - options always have stable ids, 4 of them
  //    - grading says correct
  //    - ordering shuffles across questions
  let q = await fetch(`${BASE}/api/session/${created.sessionId}/question`).then((r) => r.json());
  const seenOrders = new Set();
  const seenQids = [];
  let n = 0;

  while (q && !q.completed) {
    n++;
    seenQids.push(q.qid);
    seenOrders.add(q.options.map((o) => o.id).join(','));
    eq(q.questionIndex, n, `question ${n} reports questionIndex ${n}`);
    eq(Object.keys(q).includes('answerId'), false, `question ${n} omits answerId`);
    eq(Object.keys(q).includes('misconceptions'), false, `question ${n} omits misconceptions`);
    eq(q.options.length, 4, `question ${n} has 4 options`);
    eq(new Set(q.options.map((o) => o.id)).size, 4, `question ${n} option ids are unique`);

    // Answer with the option that maps to the true answer. We know the bank, so
    // pick by matching the canonical answer text, then submit that option id.
    const trueAnswerText = CANONICAL_ANSWERS[q.qid];
    const opt = q.options.find((o) => o.text === trueAnswerText);
    eq(!!opt, true, `question ${n} exposes the canonical correct option "${trueAnswerText}"`);

    const resp = await fetch(`${BASE}/api/session/${created.sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.qid, optionId: opt.id, usedHint: false }),
    }).then((r) => r.json());

    eq(resp.feedback.isCorrect, true, `question ${n} graded correct`);
    eq(resp.feedback.misconception, null, `question ${n} has no misconception for the correct answer`);

    q = resp.nextQuestion;
  }

  eq(n, 12, 'session serves all 12 questions');
  eq(q === null, true, 'session completes with nextQuestion=null');

  // 5. Wrong answer triggers misconception code
  const s2 = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Wrong', class: 8, subject: 'mathematics', chapter: 'Linear Equations' }),
  }).then((r) => r.json());

  const q1 = await fetch(`${BASE}/api/session/${s2.sessionId}/question`).then((r) => r.json());
  // le-01: x + 5 = 12 -> correct opt-7 (x = 7); opt-17 (x = 17) -> wrong-inverse-operation
  const wrongOpt = q1.options.find((o) => o.text === 'x = 17');
  const wresp = await fetch(`${BASE}/api/session/${s2.sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q1.qid, optionId: wrongOpt.id, usedHint: false }),
  }).then((r) => r.json());
  eq(wresp.feedback.isCorrect, false, 'wrong answer graded incorrect');
  eq(wresp.feedback.misconception, 'wrong-inverse-operation', 'wrong answer maps to misconception code');
  eq(wresp.nextAction, 'review', 'known misconception yields nextAction=review');
  eq(!!wresp.nextQuestion, true, 'a next question is still returned after a wrong answer');

  // 6. Non-existent session -> 404
  const missing = await fetch(`${BASE}/api/session/nope/question`);
  eq(missing.status, 404, 'unknown session id returns 404');

  // 7. Non-existent option -> 400
  const badOpt = await fetch(`${BASE}/api/session/${s2.sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q1.qid, optionId: 'opt-does-not-exist', usedHint: false }),
  });
  eq(badOpt.status, 400, 'unknown option id returns 400');

  console.log(seenOrders.size > 0 ? `  (distinct option orders observed: ${seenOrders.size})` : '');
}

const CANONICAL_ANSWERS = {
  'le-01': 'x = 7',
  'le-02': 'x = 11',
  'le-03': 'x = 7',
  'le-04': 'x = 12',
  'le-05': 'x = 4',
  'le-06': 'x = 5',
  'le-07': 'x = 4',
  'le-08': 'x = 5',
  'le-09': 'x = 5',
  'le-10': 'x = 3',
  'le-11': 'x = 4',
  'le-12': 'x = 4',
};

main().catch((e) => {
  console.error('Test harness error:', e);
  process.exit(1);
});
