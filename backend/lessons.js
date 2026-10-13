/**
 * Reviewed fallback lessons, one per concept in the supported chapter.
 *
 * If Gemini is unavailable, misbehaves, or fails validation, the server returns
 * one of these instead. Content is hand-reviewed and hand-verified so the
 * learning session continues with a usable visual lesson.
 */

import { lessonAnchors, conceptOrder } from './curriculum.js';
import { buildMindMap } from './engine.js';

/** Build a reviewed fallback lesson for a concept. */
export function fallbackLesson(conceptId, options = {}) {
  const anchor = lessonAnchors[conceptId] || lessonAnchors['two-step-equations'];
  const graph = buildMindMap(conceptId);
  const misconceptionNote = options.misconception
    ? ` Watch out for: ${options.misconception.replace(/-/g, ' ')}.`
    : '';

  return {
    title: anchor.title,
    mindMap: {
      nodes: graph.nodes,
      edges: graph.edges,
    },
    imageQuery: `${anchor.title}: balance diagram for ${conceptId.replace(/-/g, ' ')}`,
    steps: anchor.steps.map((s, i) => ({
      caption: `Step ${i + 1}: ${s.caption}`,
      content: s.content,
      why: s.why,
    })),
    hint: anchor.hint,
    tryNext: options.action === 'harder-challenge'
      ? `Try a question with variables on both sides.`
      : `Solve a similar problem: ${anchor.workedExample.problem}`,
    finalAnswer: anchor.workedExample.finalAnswer,
    source: 'fallback',
    notice: options.notice || `Showing the reviewed lesson for this concept.${misconceptionNote}`,
  };
}

/** The list of concepts that have reviewed fallback content. */
export function fallbackConceptIds() {
  return Object.keys(lessonAnchors);
}
