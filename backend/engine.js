/**
 * Deterministic learning engine.
 *
 * Grades answers, updates the student model, maps wrong options to misconception
 * codes, and selects the next action and question. Plain JavaScript with no AI
 * calls, so it is unit-testable and reproducible.
 *
 * The LLM personalizes the wording of a lesson; it never changes these decisions.
 */

import { questionsById, questions, questionsForCurriculum } from './questions.js';
import { ADAPTATION_CONFIG as CFG, masteryScore, minAttemptsForJudgement, bandForClass } from './config.js';
import { getMisconceptionRepository } from './curriculum-context.js';

/** Attempts required before a skill can be judged weak or strong. */
const MIN_ATTEMPTS_FOR_JUDGEMENT = minAttemptsForJudgement;

/** Rule names in first-match priority order. */
export const RULE_ORDER = [
  'prerequisite_review',
  'targeted_review',
  'guided_practice',
  'challenge',
  'same_level_practice',
];

/**
 * Backwards-compatible view of the thresholds the earlier engine tests read.
 * Values are mirrored from ADAPTATION_CONFIG, which is the single source.
 */
export const RULES = {
  consecutiveWrongForReview: CFG.repeatedWrongCount,
  recentWindow: CFG.recentWindowSize,
  minCorrectInWindow: CFG.lowRecentCorrectCount,
  minAttemptsForMastery: CFG.challengeMinAttempts,
  masteryThreshold: CFG.challengeMasteryThreshold,
  prerequisiteReviewThreshold: CFG.prerequisiteReviewThreshold,
  difficultyFloor: CFG.difficultyFloor,
  difficultyCeiling: CFG.difficultyCeiling,
};

/** Reason codes emitted by the policy. */
export const REASON_CODES = {
  PREREQUISITE_BELOW_THRESHOLD: 'PREREQUISITE_BELOW_THRESHOLD',
  REPEATED_WRONG_ON_CONCEPT: 'REPEATED_WRONG_ON_CONCEPT',
  LOW_RECENT_CORRECT: 'LOW_RECENT_CORRECT',
  MASTERY_AND_TRANSFER_PASSED: 'MASTERY_AND_TRANSFER_PASSED',
  CONTINUING_SAME_LEVEL: 'CONTINUING_SAME_LEVEL',
  MISCONCEPTION_REPAIRED: 'MISCONCEPTION_REPAIRED',
};

/**
 * Student-facing explanation templates. The displayed text is always derived
 * from the rule that actually fired, never generated freely by the LLM.
 */
const WHY_TEMPLATES = {
  [REASON_CODES.PREREQUISITE_BELOW_THRESHOLD]: (c) =>
    `${c.prerequisiteLabel} is holding you back on ${c.conceptLabel}. Let's build that base first.`,
  [REASON_CODES.REPEATED_WRONG_ON_CONCEPT]: (c) =>
    `You have missed ${c.consecutiveWrong} in a row on ${c.conceptLabel}, so let's rebuild the idea with a simpler problem first.`,
  [REASON_CODES.LOW_RECENT_CORRECT]: (c) =>
    `Only ${c.correctInWindow} of your last ${c.windowSize} were right. Let's go back a step and work through it together.`,
  [REASON_CODES.MASTERY_AND_TRANSFER_PASSED]: (c) =>
    `You are solid on ${c.conceptLabel} and passed a transfer question. Here is a harder skill: ${c.nextConceptLabel}.`,
  [REASON_CODES.CONTINUING_SAME_LEVEL]: (c) =>
    `Let's keep working on ${c.conceptLabel} so I can be sure you've got it.`,
  [REASON_CODES.MISCONCEPTION_REPAIRED]: (c) =>
    `That slip is a common one. Let's look at the idea behind ${c.conceptLabel}.`,
};

/** Build the student-facing copy for a rule. */
function explain(code, context) {
  const template = WHY_TEMPLATES[code];
  return template ? template(context) : `Next: ${code}`;
}

export function createStudentModel() {
  return {
    skills: {},       // conceptId -> { attempts, correct, consecutiveWrong, mastery, misconception }
    recentAttempts: [], // { conceptId, correct, at } newest last
    misconceptions: {}, // code -> { count, lastSeenAt }
    servedQuestionIds: [],
    correctQuestionIds: [], // qids answered correctly — transfer pass requires this, not just served
    answeredCount: 0,
    correctCount: 0,
  };
}

/** Get (creating if needed) the tracking state for one skill. */
export function getSkillState(model, conceptId) {
  if (!model.skills[conceptId]) {
    model.skills[conceptId] = {
      attempts: 0,
      correct: 0,
      consecutiveWrong: 0,
      mastery: 0,
      misconception: null,
    };
  }
  return model.skills[conceptId];
}

/**
 * Mastery is a server-side estimate. It must never be trusted from the client.
 * It is a fraction correct with a confidence buffer, so one lucky answer does
 * not read as mastery.
 */
export function masteryOf(skillState) {
  return masteryScore(skillState);
}

/**
 * Grade one answer. Returns feedback and the misconception code (or null).
 * Grading compares stable option IDs against the canonical bank answer, so
 * shuffling cannot change the result.
 */
export function gradeAnswer(question, optionId) {
  const isCorrect = optionId === question.answerId;
  const misconception = isCorrect
    ? null
    : (question.misconceptions[optionId] ?? 'unknown-misconception');
  return { isCorrect, misconception, correctOptionId: question.answerId };
}

/**
 * Apply an answer to the student model and decide what to do next.
 * This is the heart of the adaptive loop.
 */
export function updateModelAndChooseAction(model, question, isCorrect, misconception, ctx = {}) {
  const skill = getSkillState(model, question.conceptId);
  const masteryBefore = masteryOf(skill);

  skill.attempts += 1;
  model.answeredCount += 1;

  if (isCorrect) {
    skill.correct += 1;
    skill.consecutiveWrong = 0;
    model.correctCount += 1;
    // Transfer pass requires a *correct* answer, not just seeing the question.
    if (!model.correctQuestionIds) model.correctQuestionIds = [];
    if (!model.correctQuestionIds.includes(question.qid)) {
      model.correctQuestionIds.push(question.qid);
    }
  } else {
    skill.consecutiveWrong += 1;
    if (misconception) skill.misconception = misconception;
  }

  skill.mastery = masteryOf(skill);

  model.recentAttempts.push({ conceptId: question.conceptId, correct: isCorrect, at: Date.now() });
  if (model.recentAttempts.length > 10) model.recentAttempts.shift();

  if (misconception) {
    const prev = model.misconceptions[misconception] || { count: 0, lastSeenAt: 0 };
    prev.count += 1;
    prev.lastSeenAt = Date.now();
    model.misconceptions[misconception] = prev;
  }

  const decision = chooseNextAction(model, question, isCorrect, misconception);

  // Full adaptation evidence, replayable from stored state.
  decision.evidence = {
    rule: decision.rule,
    reasonCodes: decision.reasonCodes,
    conceptId: question.conceptId,
    attempts: skill.attempts,
    correct: skill.correct,
    masteryBefore: round(masteryBefore),
    masteryAfter: round(skill.mastery),
    consecutiveWrong: skill.consecutiveWrong,
    transferPassed: passedTransferFor(model, question.conceptId),
    policyVersion: CFG.policyVersion,
    curriculumId: ctx.curriculumId || null,
    contentVersion: ctx.contentVersion || null,
  };

  return { skill, masteryAfter: skill.mastery, decision };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * The next-action policy, evaluated in first-match order:
 *  1. A tested prerequisite is below the threshold -> review it with easier practice
 *  2. Two consecutive wrong on a concept -> targeted review, easier practice
 *  3. Fewer than 2 correct in the last 4 -> guided practice
 *  4. Enough attempts, mastery >= 0.8 and a transfer pass -> challenge
 *  5. Otherwise -> keep practising at the same level
 */
export function chooseNextAction(model, question, isCorrect, misconception) {
  const skillId = question.conceptId;
  const skill = model.skills[skillId];

  // ---- Rule 1: a prerequisite the student has actually tested weak on.
  const weakPrereq = firstWeakPrerequisite(model, skillId);
  if (weakPrereq) {
    return decide({
      rule: 'prerequisite_review',
      code: 'prerequisite-review',
      reasonCodes: [REASON_CODES.PREREQUISITE_BELOW_THRESHOLD],
      skillId: weakPrereq.id,
      direction: 'easier',
      lesson: true,
      misconception: weakPrereq.misconception,
      context: {
        prerequisiteLabel: weakPrereq.label,
        conceptLabel: label(skillId),
        conceptLabelCurrent: label(skillId),
      },
      extras: { prerequisiteConceptId: weakPrereq.id, prerequisiteMastery: weakPrereq.mastery },
    });
  }

  // ---- Rule 2: repeated failure on the same concept.
  if (skill.consecutiveWrong >= CFG.repeatedWrongCount) {
    return decide({
      rule: 'targeted_review',
      code: 'targeted-review',
      reasonCodes: [REASON_CODES.REPEATED_WRONG_ON_CONCEPT],
      skillId,
      direction: 'easier',
      lesson: true,
      misconception: skill.misconception || misconception,
      context: { conceptLabel: label(skillId), consecutiveWrong: skill.consecutiveWrong },
    });
  }

  // ---- Rule 3: struggling overall across the recent window.
  const recent = model.recentAttempts.slice(-CFG.recentWindowSize);
  const correctInWindow = recent.filter((a) => a.correct).length;
  if (recent.length >= CFG.recentWindowSize && correctInWindow < CFG.lowRecentCorrectCount) {
    return decide({
      rule: 'guided_practice',
      code: 'guided-practice',
      reasonCodes: [REASON_CODES.LOW_RECENT_CORRECT],
      skillId,
      direction: 'easier',
      lesson: true,
      misconception: skill.misconception || misconception,
      context: {
        conceptLabel: label(skillId),
        correctInWindow,
        windowSize: CFG.recentWindowSize,
      },
    });
  }

  // ---- Rule 4: mastery plus a passed transfer question.
  const transferPassed = passedTransferFor(model, skillId);
  if (
    skill.attempts >= CFG.challengeMinAttempts &&
    skill.mastery >= CFG.challengeMasteryThreshold &&
    (!CFG.requireTransferPassForChallenge || transferPassed)
  ) {
    const nextSkill = nextConcept(skillId);
    return decide({
      rule: 'challenge',
      code: 'harder-challenge',
      reasonCodes: [REASON_CODES.MASTERY_AND_TRANSFER_PASSED],
      skillId: nextSkill || skillId,
      direction: 'harder',
      lesson: false,
      misconception: null,
      context: {
        conceptLabel: label(skillId),
        nextConceptLabel: label(nextSkill) || 'a harder challenge',
      },
    });
  }

  // ---- Rule 5: keep gathering evidence at the current level.
  if (misconception && !isCorrect) {
    return decide({
      rule: 'misconception_repair',
      code: 'misconception-repair',
      reasonCodes: [REASON_CODES.MISCONCEPTION_REPAIRED],
      skillId,
      direction: 'same',
      lesson: true,
      misconception,
      context: { conceptLabel: label(skillId) },
    });
  }

  return decide({
    rule: 'same_level_practice',
    code: 'continue',
    reasonCodes: [REASON_CODES.CONTINUING_SAME_LEVEL],
    skillId,
    direction: 'same',
    lesson: false,
    misconception: null,
    context: { conceptLabel: label(skillId) },
  });
}

function decide({
  rule, code, reasonCodes, skillId, direction, lesson, misconception, context, extras,
}) {
  return {
    action: code,
    rule,
    reasonCodes,
    skillId,
    direction,
    lesson,
    misconception: misconception || null,
    reason: explain(reasonCodes[0], context),
    ...(extras || {}),
  };
}

/** Human label for a concept, read from the loaded curriculum when available. */
function label(conceptId) {
  const repo = getMisconceptionRepository();
  const concept = repo?.getConcept(repo.listCurricula()[0]?.id, conceptId);
  return concept?.title || conceptId;
}

/**
 * A prerequisite that has been attempted enough times to judge and is below the
 * review threshold. Untested prerequisites are never treated as weak — one
 * unlucky miss must not be able to redirect the whole lesson.
 */
function firstWeakPrerequisite(model, conceptId) {
  let current = conceptId;
  const visited = new Set();

  for (let depth = 0; depth < 10; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const prereqIds = prereqsFor(current);
    for (const prereqId of prereqIds) {
      const state = model.skills[prereqId];
      // Not enough evidence yet — do not judge.
      if (!state || state.attempts < MIN_ATTEMPTS_FOR_JUDGEMENT) continue;
      const score = masteryOf(state);
      if (score < CFG.prerequisiteReviewThreshold) {
        return {
          id: prereqId,
          label: label(prereqId),
          mastery: round(score),
          misconception: state.misconception,
        };
      }
    }
    const first = prereqIds[0];
    if (!first) break;
    current = first;
  }
  return null;
}

/** Prerequisite ids for a concept, from the loaded curriculum graph. */
function prereqsFor(conceptId) {
  const repo = getMisconceptionRepository();
  if (!repo) return [];
  for (const curriculum of repo.listCurricula()) {
    const concept = repo.getConcept(curriculum.id, conceptId);
    if (concept) return concept.prerequisiteConceptIds || [];
  }
  return [];
}

/** Did the student answer a transfer question correctly for this concept? */
export function passedTransferFor(model, conceptId) {
  const transferIds = questions
    .filter((q) => q.isTransfer && q.conceptId === conceptId)
    .map((q) => q.qid);
  if (transferIds.length === 0) return false;
  // Backward compat: sessions created before correctQuestionIds existed.
  const correctIds = model.correctQuestionIds || [];
  return transferIds.some((qid) => correctIds.includes(qid));
}

/** The next concept in the difficulty progression, if any. */
export function nextConcept(conceptId) {
  const repo = getMisconceptionRepository();
  const order = repo ? repo.conceptsInOrder() : [];
  const list = order.length ? order : conceptOrderFallback();
  const i = list.indexOf(conceptId);
  if (i === -1 || i === list.length - 1) return null;
  return list[i + 1];
}

function conceptOrderFallback() {
  return ['number-sense', 'inverse-operations', 'distributive-parenthesis', 'two-step-equations', 'variables-both-sides'];
}

/**
 * Select the next practice question from the verified bank.
 * Prefer the diagnosed concept, target difficulty, unseen questions, and (when
 * repairing a misconception) a question whose distractors test that error.
 */
export function selectNextQuestion(model, targetConceptId, direction, ctx = {}) {
  const bank = ctx.curriculumId ? curriculumQuestions(ctx.curriculumId) : questions;
  const target = targetDifficulty(model, targetConceptId, direction, bank);
  let pool = bank.filter(
    (q) => q.conceptId === target.conceptId && q.difficulty === target.difficulty
  );

  const unseen = pool.filter((q) => !model.servedQuestionIds.includes(q.qid));
  if (unseen.length > 0) {
    pool = unseen;
  } else {
    // Target slot is fully served — force fallback to unseen material elsewhere
    // instead of repeating a served question forever (killed the 4-Q demo).
    pool = [];
  }

  if (pool.length === 0) {
    pool = bank.filter((q) => q.conceptId === target.conceptId && !model.servedQuestionIds.includes(q.qid));
    if (pool.length === 0) {
      pool = bank.filter((q) => !model.servedQuestionIds.includes(q.qid));
    }
    if (pool.length === 0) {
      pool = bank.filter((q) => q.conceptId === target.conceptId);
    }
  }

  const activeMisconception = model.misconceptions &&
    Object.entries(model.misconceptions)
      .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)[0]?.[0];
  if (activeMisconception) {
    const targeted = pool.filter((q) => Object.values(q.misconceptions).includes(activeMisconception));
    if (targeted.length > 0) return targeted[0];
  }

  return pool[0];
}

/** Approved questions for a curriculum, in pack order. */
function curriculumQuestions(curriculumId) {
  try {
    return questionsForCurriculum(curriculumId);
  } catch {
    // A broken pack must not silently change grading behaviour.
    console.error(`[engine] pack ${curriculumId} unreadable; using the reference bank`);
    return questions;
  }
}

function targetDifficulty(model, conceptId, direction, bank) {
  let skill = conceptId;
  let base = maxDifficultyFor(skill, bank);

  if (direction === 'easier') {
    const step = stepDown(skill, bank);
    if (step.skill !== skill) {
      skill = step.skill;
      base = maxDifficultyFor(skill, bank);
    } else {
      base = Math.max(CFG.difficultyFloor, base - 1);
    }
  } else if (direction === 'harder') {
    const harder = Math.min(CFG.difficultyCeiling, base + 1);
    if (harder > base) base = harder;
    if (!bank.some((q) => q.conceptId === skill && q.difficulty === base)) {
      const next = nextConcept(skill);
      if (next) {
        skill = next;
        base = minDifficultyFor(next, bank);
      }
    }
  }

  return { conceptId: skill, difficulty: clampDifficulty(base) };
}

function clampDifficulty(d) {
  return Math.max(CFG.difficultyFloor, Math.min(CFG.difficultyCeiling, d));
}

function maxDifficultyFor(conceptId, bank = questions) {
  const served = bank.filter((q) => q.conceptId === conceptId);
  if (served.length === 0) return minDifficultyFor(conceptId, bank);
  return Math.max(...served.map((q) => q.difficulty));
}

function minDifficultyFor(conceptId, bank = questions) {
  const served = bank.filter((q) => q.conceptId === conceptId);
  if (served.length === 0) return CFG.difficultyFloor;
  return Math.min(...served.map((q) => q.difficulty));
}

/** Move back one concept, or drop difficulty within it. */
function stepDown(conceptId, bank = questions) {
  const hardest = maxDifficultyFor(conceptId, bank);
  if (hardest > CFG.difficultyFloor) {
    return { skill: conceptId, difficulty: hardest - 1 };
  }
  const repo = getMisconceptionRepository();
  const order = repo ? repo.conceptsInOrder() : conceptOrderFallback();
  const i = order.indexOf(conceptId);
  if (i > 0) return { skill: order[i - 1], difficulty: CFG.difficultyCeiling };
  return { skill: conceptId, difficulty: CFG.difficultyFloor };
}

/** Pick a question for the opening diagnostic round. */
export function selectDiagnosticQuestion(model, ctx = {}) {
  const bank = ctx.curriculumId ? curriculumQuestions(ctx.curriculumId) : questions;
  const unseen = bank.filter((q) => !model.servedQuestionIds.includes(q.qid));
  if (unseen.length === 0) return null;
  const ordered = [...unseen].sort((a, b) => {
    const ia = conceptIndex(a.conceptId);
    const ib = conceptIndex(b.conceptId);
    if (ia !== ib) return ia - ib;
    return a.difficulty - b.difficulty;
  });
  return ordered[0];
}

function conceptIndex(conceptId) {
  const repo = getMisconceptionRepository();
  const order = repo ? repo.conceptsInOrder() : conceptOrderFallback();
  const i = order.indexOf(conceptId);
  return i === -1 ? 99 : i;
}

/** Mark a question as served so it is not repeated immediately. */
export function markServed(model, qid) {
  if (!model.servedQuestionIds.includes(qid)) {
    model.servedQuestionIds.push(qid);
  }
}

/** The canonical concept graph, with mastery-driven node state for the UI. */
export function buildMindMap(conceptId, model = null, curriculumId = null) {
  const repo = getMisconceptionRepository();
  let all = [];
  let edges = [];
  if (repo && curriculumId) {
    for (const concept of repo.allConcepts(curriculumId)) all.push(concept);
    edges = repo.conceptEdges(curriculumId);
  }
  if (all.length === 0) {
    all = conceptOrderFallback().map((id) => ({ id, title: id }));
    edges = conceptOrderFallback()
      .slice(1)
      .map((id, i) => ({ from: conceptOrderFallback()[i], to: id }));
  }

  // Classify every node by its position in the prerequisite graph: ancestors of
  // the current concept are prerequisites, descendants are what it leads to.
  const ancestorsOf = new Set();
  const descendantsOf = new Set();
  const incoming = new Map(edges.map((e) => [e.to, e]));
  const outgoing = new Map(edges.map((e) => [e.from, e]));

  let walker = incoming.get(conceptId);
  while (walker) {
    ancestorsOf.add(walker.from);
    walker = incoming.get(walker.from);
  }
  let forward = outgoing.get(conceptId);
  while (forward) {
    descendantsOf.add(forward.to);
    forward = outgoing.get(forward.to);
  }

  const stateFor = (id) => {
    if (!model) return 'not_tested';
    const s = model.skills[id];
    if (!s || s.attempts === 0) return 'not_tested';
    if (s.attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT && s.mastery >= CFG.challengeMasteryThreshold) return 'solid';
    if (s.attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT && s.mastery < CFG.prerequisiteReviewThreshold) return 'needs_review';
    return 'developing';
  };

  const nodes = all.map((c) => {
    let type = 'prerequisite';
    if (c.id === conceptId) type = 'current';
    else if (descendantsOf.has(c.id)) type = 'target';
    else if (ancestorsOf.has(c.id)) type = 'prerequisite';

    const state = stateFor(c.id);
    const attempts = model?.skills[c.id]?.attempts ?? 0;
    const hasEvidence = attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT;
    return {
      id: c.id,
      label: c.title,
      type,
      // A concept the student has barely touched must not read as "developing".
      state: hasEvidence ? state : 'not_tested',
      mastery: hasEvidence ? Math.round(masteryOf(model.skills[c.id]) * 100) : 0,
      attempts,
    };
  });

  return { nodes, edges: edges.map((e) => ({ from: e.from, to: e.to })), currentConceptId: conceptId };
}

/**
 * Progress recap: what was practised, what is developing, what is next.
 */
export function buildProgressRecap(model, curriculumId = null) {
  const skillIds = Object.keys(model.skills);
  const skills = skillIds.map((id) => {
    const s = model.skills[id];
    const hasEvidence = s.attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT;
    // `state` is the four-state mind-map vocabulary; `status` is the coarser
    // developing / ready-for-challenge label used by the recap and existing UI.
    const state = !hasEvidence
      ? 'not_tested'
      : s.mastery >= CFG.challengeMasteryThreshold && s.attempts >= CFG.challengeMinAttempts
      ? 'solid'
      : s.mastery < CFG.prerequisiteReviewThreshold
      ? 'needs_review'
      : 'developing';
    return {
      conceptId: id,
      label: label(id),
      attempts: s.attempts,
      correct: s.correct,
      mastery: Math.round(masteryOf(s) * 100),
      state,
      status:
        hasEvidence && s.mastery >= CFG.challengeMasteryThreshold && s.attempts >= CFG.challengeMinAttempts
          ? 'ready-for-challenge'
          : 'developing',
      misconception: s.misconception,
    };
  });

  const weakest = [...skills].sort((a, b) => a.mastery - b.mastery)[0];
  const strongest = [...skills].sort((a, b) => b.mastery - a.mastery)[0];

  return {
    answered: model.answeredCount,
    correct: model.correctCount,
    accuracy: model.answeredCount ? Math.round((model.correctCount / model.answeredCount) * 100) : 0,
    skills,
    misconceptions: Object.entries(model.misconceptions)
      .map(([code, meta]) => ({
        code,
        label: misconceptionText(code, curriculumId),
        count: meta.count,
      }))
      .sort((a, b) => b.count - a.count),
    nextRecommendedAction: weakest
      ? `Practise ${weakest.label} — your mastery there is ${weakest.mastery}%.`
      : 'Start a new chapter.',
    strength: strongest ? strongest.label : null,
    curriculumId,
  };
}

function misconceptionText(code, curriculumId) {
  const repo = getMisconceptionRepository();
  if (repo && curriculumId) {
    const text = repo.getMisconceptionExplanation(curriculumId, code);
    if (text) return text;
  }
  return code.replace(/-/g, ' ');
}

/** Plain per-concept evidence snapshot, safe to store on the session. */
export function snapshotSkills(model) {
  const out = {};
  for (const [id, s] of Object.entries(model.skills || {})) {
    out[id] = {
      attempts: s.attempts || 0,
      correct: s.correct || 0,
      mastery: Math.round(masteryOf(s) * 100),
      misconception: s.misconception || null,
    };
  }
  return out;
}

/** Concept ids in prerequisite order (canonical graph, never invented). */
function orderedConcepts() {
  const repo = getMisconceptionRepository();
  const order = repo ? repo.conceptsInOrder() : [];
  return order.length ? order : conceptOrderFallback();
}

/**
 * Diagnosis from diagnostic evidence: strengths, gaps, and misconceptions
 * labelled by confidence. A single ambiguous wrong answer is only ever a
 * *possible* gap; a repeated pattern is reported as repeated.
 */
export function buildDiagnosis(model, curriculumId = null) {
  const snap = snapshotSkills(model);
  const strengths = [];
  const gaps = [];
  const uncertain = [];
  for (const [id, s] of Object.entries(snap)) {
    if (s.attempts < MIN_ATTEMPTS_FOR_JUDGEMENT) {
      if (s.attempts > 0) uncertain.push({ conceptId: id, label: label(id), attempts: s.attempts });
      continue;
    }
    const row = { conceptId: id, label: label(id), attempts: s.attempts, correct: s.correct, mastery: s.mastery };
    if (s.mastery >= CFG.challengeMasteryThreshold * 100) strengths.push(row);
    else if (s.mastery < CFG.prerequisiteReviewThreshold * 100) gaps.push(row);
    // In-between mastery is still forming: neither strength nor gap.
  }
  gaps.sort((a, b) => a.mastery - b.mastery);
  strengths.sort((a, b) => b.mastery - a.mastery);

  const misconceptions = Object.entries(model.misconceptions || {})
    .map(([code, meta]) => ({
      code,
      label: misconceptionText(code, curriculumId),
      count: meta.count || 0,
      // One sighting is not proof of a misconception.
      confidence: (meta.count || 0) >= 2 ? 'repeated-pattern' : 'possible-gap',
    }))
    .sort((a, b) => b.count - a.count);

  return {
    strengths,
    gaps,
    uncertain,
    misconceptions,
    path: buildLearningPath(model, curriculumId),
    policyVersion: CFG.policyVersion,
  };
}

/**
 * Short ordered learning path generated from evidence. Every step links a
 * real concept and carries the reason it is in the path — no invented steps,
 * no fake completion states.
 */
export function buildLearningPath(model, curriculumId = null) {
  const snap = snapshotSkills(model);
  const order = orderedConcepts();
  const gaps = Object.entries(snap)
    .filter(([, s]) => s.attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT && s.mastery < CFG.prerequisiteReviewThreshold * 100)
    .sort((a, b) => a[1].mastery - b[1].mastery)
    .map(([id]) => id);
  const strengths = Object.entries(snap)
    .filter(([, s]) => s.attempts >= MIN_ATTEMPTS_FOR_JUDGEMENT && s.mastery >= CFG.challengeMasteryThreshold * 100)
    .map(([id]) => id);

  const steps = [];
  const push = (action, kind, conceptId, reason, extra) => {
    steps.push({ order: steps.length + 1, action, kind, conceptId, label: label(conceptId), reason, ...(extra || {}) });
  };

  const focus = gaps[0] || strengths[0] || order[0];
  if (gaps.length > 0) {
    // Surface the prerequisite chain that actually blocks the focus concept.
    const prereq = firstWeakPrerequisite(model, focus);
    if (prereq) {
      push('prerequisite-review', 'lesson', prereq.id,
        `${prereq.label} is at ${Math.round(prereq.mastery * 100)}% mastery and ${label(focus)} builds on it, so we rebuild that base first.`);
    }
    const s = snap[focus];
    push('targeted-review', 'lesson', focus,
      `${label(focus)} is at ${s.mastery}% after ${s.attempts} attempts, so we reteach the idea visually before more practice.`);
    push('guided-practice', 'practice', focus,
      `Two guided questions on ${label(focus)} with hints, to test whether the reteaching landed.`, { count: 2 });
  } else if (strengths.length > 0) {
    const s = snap[focus];
    push('harder-challenge', 'practice', focus,
      `${label(focus)} is at ${s.mastery}% — a concise recap plus a transfer question instead of a full reteach.`);
  } else {
    push('continue', 'practice', focus,
      `Not enough evidence yet on ${label(focus)} — a few more questions will sharpen the picture.`);
  }
  push('post-assessment', 'assessment', focus,
    `An independent check on ${label(focus)} with different questions, so we can measure what actually improved.`);

  return { focusConceptId: focus, steps };
}

/**
 * Post-assessment queue: unseen verified questions on the attempted concepts
 * first (different questions where possible), then honest retakes ordered
 * weakest-concept-first when the bank is exhausted. Pure and unit-tested;
 * the route only stages what this returns.
 */
export function buildPostQueue(bank, attemptedConceptIds, servedQuestionIds, weaknessOf, maxQuestions) {
  const attempted = new Set(attemptedConceptIds || []);
  const served = new Set(servedQuestionIds || []);
  const order = orderedConcepts();
  const rank = (id) => {
    const i = order.indexOf(id);
    return i === -1 ? 99 : i;
  };
  const max = maxQuestions || CFG.postAssessment.maxQuestions;
  const onAttempted = (q) => attempted.has(q.conceptId);
  const unseen = bank
    .filter((q) => onAttempted(q) && !served.has(q.qid))
    .sort((a, b) => rank(a.conceptId) - rank(b.conceptId) || a.difficulty - b.difficulty);
  const retakes = bank
    .filter((q) => onAttempted(q) && served.has(q.qid))
    .sort((a, b) => weaknessOf(a.conceptId) - weaknessOf(b.conceptId) || a.difficulty - b.difficulty);
  const queue = [...unseen, ...retakes].slice(0, max).map((q) => q.qid);
  return { queue, retake: queue.length > 0 && served.has(queue[0]) };
}

/**
 * Before/after comparison of diagnostic vs post-assessment evidence.
 * Never fakes progress: concepts without post evidence read as unmeasured,
 * and a flat or negative delta is reported honestly.
 */
export function buildResults(stageEvidence, diagnosticSnapshot, model, curriculumId = null) {
  // Prefer the frozen diagnostic snapshot; sessions that never finished the
  // diagnostic (demo mode, mid-diagnostic checks) fall back to the
  // stage-tagged diagnostic bucket so results still compare like with like.
  const diagBucket = (stageEvidence && stageEvidence.diagnostic && stageEvidence.diagnostic.concepts) || {};
  const diag = (diagnosticSnapshot && diagnosticSnapshot.concepts && Object.keys(diagnosticSnapshot.concepts).length
    ? diagnosticSnapshot.concepts
    : diagBucket);
  const post = (stageEvidence && stageEvidence.post && stageEvidence.post.concepts) || {};
  const order = orderedConcepts();
  const ids = [...new Set([...Object.keys(diag), ...Object.keys(post)])]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const acc = (s) => (s && s.attempts ? Math.round((s.correct / s.attempts) * 100) : null);
  const perConcept = ids.map((id) => {
    const d = diag[id] || { attempts: 0, correct: 0 };
    const p = post[id] || { attempts: 0, correct: 0 };
    const before = acc(d);
    const after = acc(p);
    const measured = p.attempts >= CFG.postAssessment.minAttempts;
    const demonstrated = measured && (p.correct / p.attempts) >= CFG.postAssessment.demonstratedThreshold;
    return {
      conceptId: id,
      label: label(id),
      diagnosticAttempts: d.attempts,
      diagnosticCorrect: d.correct,
      before,
      postAttempts: p.attempts,
      postCorrect: p.correct,
      after,
      delta: before !== null && after !== null ? after - before : null,
      measured,
      demonstrated,
      needsPractice: !demonstrated,
    };
  });

  const sum = (rows, key) => rows.reduce((t, r) => ({ a: t.a + r[key + 'Attempts'], c: t.c + r[key + 'Correct'] }), { a: 0, c: 0 });
  const dTot = sum(perConcept, 'diagnostic');
  const pTot = sum(perConcept, 'post');
  const diagAccuracy = dTot.a ? Math.round((dTot.c / dTot.a) * 100) : null;
  const postAccuracy = pTot.a ? Math.round((pTot.c / pTot.a) * 100) : null;

  const demonstrated = perConcept.filter((r) => r.demonstrated);
  const needsPractice = perConcept.filter((r) => r.needsPractice);
  const unmeasured = perConcept.filter((r) => !r.measured);
  const weakest = [...needsPractice].sort((a, b) => (a.after ?? 101) - (b.after ?? 101))[0];

  const nextStep = pTot.a === 0
    ? 'Take the post-assessment to measure what changed since the diagnostic.'
    : weakest
    ? `Keep practising ${weakest.label} — it is not demonstrated yet${weakest.after !== null ? ` (post-assessment ${weakest.after}%)` : ''}.`
    : 'Every practised objective is demonstrated — advance to the next supported topic.';

  return {
    diagnostic: { answered: dTot.a, correct: dTot.c, accuracy: diagAccuracy },
    post: { answered: pTot.a, correct: pTot.c, accuracy: postAccuracy },
    change: diagAccuracy !== null && postAccuracy !== null ? postAccuracy - diagAccuracy : null,
    perConcept,
    demonstrated: demonstrated.map((r) => r.conceptId),
    needsPractice: needsPractice.map((r) => r.conceptId),
    unmeasured: unmeasured.map((r) => r.conceptId),
    nextStep,
    policyVersion: CFG.policyVersion,
  };
}
