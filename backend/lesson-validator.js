/**
 * Domain validation for lesson output.
 *
 * Schema-valid JSON can still be factually wrong, so this adds the checks the
 * schema cannot express: ids must exist in the approved curriculum, the worked
 * answer must match the canonical one, and the mind map may only reference
 * canonical concept ids.
 */

import { lessonOutputSchema } from './lesson-schema.js';

/** Compare answers ignoring case, spaces and common formatting. */
function normalizeAnswer(value) {
  return String(value)
    .toLowerCase()
    .replace(/[{}`]/g, '')
    .replace(/\\[left|right]/g, '')
    .replace(/\s+/g, '')
    .replace(/×|\\times/g, '*')
    .replace(/÷|\\div/g, '/');
}

/**
 * @param {object} payload raw provider output
 * @param {object} context the server-controlled lesson context
 * @returns {{ok: true, lesson: object} | {ok: false, error: string, details: any}}
 */
export function validateLesson(payload, context) {
  const parsed = lessonOutputSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Lesson failed schema validation',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const lesson = parsed.data;

  // conceptId must be the concept the policy actually selected.
  if (lesson.conceptId !== context.conceptId) {
    return fail(
      'conceptId does not match the selected concept',
      { got: lesson.conceptId, expected: context.conceptId }
    );
  }

  // The worked example must be the approved one, unchanged.
  const anchor = context.workedExample;
  if (!anchor) {
    return fail('no approved worked example exists for this concept', null);
  }
  if (lesson.workedExample.sourceExampleId !== anchor.sourceExampleId) {
    return fail(
      'worked example sourceExampleId is not the approved example',
      { got: lesson.workedExample.sourceExampleId, expected: anchor.sourceExampleId }
    );
  }
  if (lesson.workedExample.question !== anchor.problem) {
    return fail(
      'worked example question was changed',
      { got: lesson.workedExample.question, expected: anchor.problem }
    );
  }

  // The final answer must match the canonical answer. The backend computes the
  // canonical answer, so a mismatch is always rejected.
  if (normalizeAnswer(lesson.workedExample.finalAnswer) !== normalizeAnswer(anchor.finalAnswer)) {
    return fail(
      'final answer did not match the canonical expected answer',
      { got: lesson.workedExample.finalAnswer, expected: anchor.finalAnswer }
    );
  }

  // tryNextQuestionId must be an approved, verified question for this curriculum.
  const nextQuestion = context.repo?.getQuestion(context.curriculumId, lesson.tryNextQuestionId);
  if (!nextQuestion) {
    return fail(
      'tryNextQuestionId is not an approved question',
      { got: lesson.tryNextQuestionId }
    );
  }
  if (nextQuestion.conceptId !== context.conceptId) {
    return fail(
      'tryNextQuestionId belongs to a different concept',
      { got: lesson.tryNextQuestionId, concept: nextQuestion.conceptId }
    );
  }

  // Mind map may only reference canonical concepts.
  const allowed = new Set(context.allowedConceptIds || []);
  const outside = [
    ...lesson.mindMap.emphasizedConceptIds,
    ...lesson.mindMap.explanationLabels.map((l) => l.conceptId),
    lesson.mindMap.focusConceptId,
  ].filter((id) => id !== context.conceptId && !allowed.has(id));
  if (outside.length) {
    return fail('mind map references concepts that are not in the canonical graph', { outside });
  }
  if (lesson.mindMap.focusConceptId !== context.conceptId) {
    return fail(
      'mind map focusConceptId does not match the selected concept',
      { got: lesson.mindMap.focusConceptId, expected: context.conceptId }
    );
  }

  // Sources must exist in the curriculum.
  for (const sourceId of lesson.sourceIds) {
    if (!context.repo?.sources?.has(sourceId)) {
      return fail('sourceIds references an unknown source', { got: sourceId });
    }
  }

  return { ok: true, lesson: enrichForUi(lesson, context) };
}

function fail(error, details) {
  return { ok: false, error, details };
}

/**
 * Merge the AI's personalisation with the server's canonical facts so the UI
 * always renders the true graph, the true worked answer and the true sources.
 */
function enrichForUi(lesson, context) {
  const graph = context.canonicalMindMap;
  const emphasis = new Set(
    [lesson.mindMap.focusConceptId, ...lesson.mindMap.emphasizedConceptIds].filter(Boolean)
  );
  const labelByConcept = new Map(
    lesson.mindMap.explanationLabels.map((l) => [l.conceptId, l.label])
  );

  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    label: labelByConcept.get(n.id) || n.label,
    type: n.id === context.conceptId ? 'current' : n.type,
    state: n.state || 'not_tested',
    mastery: n.mastery || 0,
    attempts: n.attempts || 0,
  }));

  // Canonical topology always comes from the approved graph, never the model.
  const edges = graph.edges.map((e) => ({ from: e.from, to: e.to }));

  return {
    // New contract fields.
    conceptId: lesson.conceptId,
    lessonType: lesson.lessonType,
    title: lesson.title,
    learningObjective: lesson.learningObjective,
    explanation: lesson.explanation,
    workedExample: lesson.workedExample,
    hint: lesson.hint,
    tryNextQuestionId: lesson.tryNextQuestionId,
    mindMap: { nodes, edges, focusConceptId: context.conceptId, emphasizedConceptIds: [...emphasis] },
    sourceIds: lesson.sourceIds,

    // Backward-compatible Phase-2 fields existing consumers still read.
    steps: lesson.workedExample.steps.map((s, i) => ({
      caption: `Step ${i + 1}`,
      content: s.step,
      why: s.why,
    })),
    tryNext: `Try a question that tests ${context.conceptLabel}.`,
    finalAnswer: lesson.workedExample.finalAnswer,
    reviewedProblem: lesson.workedExample.question,
    expectedAnswer: context.workedExample.finalAnswer,

    // Facts the UI needs that the AI must not control.
    source: 'gemini',
    conceptIdSession: context.conceptId,
    nextAction: context.action,
    contentVersion: context.contentVersion,
    policyVersion: context.policyVersion || null,
    notice: null,
  };
}
