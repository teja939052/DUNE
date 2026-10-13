/**
 * Reviewed fallback lessons.
 *
 * Hand-authored, hand-verified content for every concept that has an approved
 * lesson anchor. Used whenever the AI provider is missing, slow, rate limited,
 * malformed or factually wrong, so the learning journey always continues.
 */

import { lessonTypeFor } from './lesson-generator.js';

/**
 * @param {object} context server-controlled lesson context
 * @param {object} repo curriculum repository, for canonical graph and anchors
 */
export function reviewedFallbackLesson(context, repo) {
  const anchor = repo.getLessonAnchor(context.curriculumId, context.conceptId)
    || repo.getLessonAnchor(context.curriculumId, 'two-step-equations')
    || { title: context.conceptLabel, steps: [], workedExample: null, hint: '', mindMap: [] };

  const graph = context.canonicalMindMap;
  const nodes = (graph?.nodes || []).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.id === context.conceptId ? 'current' : n.type,
    state: n.state || 'not_tested',
    mastery: n.mastery || 0,
    attempts: n.attempts || 0,
  }));
  const edges = (graph?.edges || []).map((e) => ({ from: e.from, to: e.to }));

  const misconceptionNote = context.misconception
    ? ` Watch out for: ${String(context.misconception).replace(/-/g, ' ')}.`
    : '';

  const steps = (anchor.steps || []).map((s, i) => ({
    step: `${s.caption}: ${s.content}`,
    why: s.why,
  }));

  const workedExample = anchor.workedExample || { problem: '', finalAnswer: '' };

  return {
    // Preferred new contract.
    conceptId: context.conceptId,
    lessonType: lessonTypeFor(context.action),
    title: anchor.title,
    learningObjective: context.actionReason,
    explanation:
      `Here is the reviewed lesson for ${context.conceptLabel}. ` +
      `The idea is short: follow the steps and check the balance at every move.` +
      misconceptionNote,
    workedExample: {
      sourceExampleId: anchor.sourceExampleId || `${context.conceptId}-worked-example`,
      question: workedExample.problem,
      steps: steps.length
        ? steps
        : [{ step: 'Work through the problem on paper.', why: 'Practising the steps builds fluency.' }],
      finalAnswer: workedExample.finalAnswer,
    },
    hint: anchor.hint || 'Try the opposite operation on both sides.',
    tryNextQuestionId: context.tryNextQuestionId || null,
    mindMap: {
      nodes,
      edges,
      focusConceptId: context.conceptId,
      emphasizedConceptIds: [context.conceptId],
    },
    sourceIds: context.sourceIds || [],

    // Backward-compatible Phase-2 fields.
    steps: steps.length
      ? steps.map((s, i) => ({ caption: `Step ${i + 1}`, content: workedExampleSteps(steps, i), why: s.why }))
      : [{ caption: 'Step 1', content: workedExample.problem, why: 'Follow the steps and check your answer.' }],
    tryNext: context.tryNextQuestionId
      ? 'Solve the next question that tests the same idea.'
      : 'Practise another question from this concept.',
    finalAnswer: workedExample.finalAnswer,
    reviewedProblem: workedExample.problem,
    expectedAnswer: workedExample.finalAnswer,

    source: 'fallback',
    conceptIdSession: context.conceptId,
    nextAction: context.action,
    contentVersion: context.contentVersion,
    policyVersion: context.policyVersion || null,
    notice:
      context.notice ||
      'AI lessons are unavailable right now, so this reviewed lesson is shown instead.',
  };
}

function workedExampleSteps(steps, index) {
  return steps[index] ? steps[index].step : '';
}
