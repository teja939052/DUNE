/**
 * Class 8 Linear Equations question bank — served from the content pack.
 *
 * The pack at `content-packs/IN/AP-SSC/2024-25/class-08/mathematics/questions.json`
 * is the single source of truth. This module is a thin adapter that normalises
 * the pack record into the shape the engine and API have always used, so the
 * verified answers, misconception mappings and stable option IDs are unchanged
 * while the data now genuinely flows through the curriculum layer.
 *
 * If the pack cannot be read, this throws at startup rather than silently
 * serving a stale copy — a pack that fails validation must be loud.
 */

import { getRepository } from './curriculum-context.js';

export const REFERENCE_CURRICULUM = 'IN.AP-SSC.2024-25';
export const REFERENCE_GRADE = 8;

/**
 * Pack record -> the engine's long-standing question shape.
 *
 * `answerId` and `misconceptions` exist only here, server-side. They are
 * stripped by `publicQuestion()` in index.js before anything reaches the browser.
 */
export function normalizeQuestion(record) {
  return {
    qid: record.id,
    conceptId: record.conceptId,
    difficulty: record.difficulty,
    stem: record.prompt,
    options: (record.options || []).map((o) => ({ id: o.id, text: o.text })),
    answerId: record.correctOptionId,
    misconceptions: record.misconceptionByOption || {},
    explanation: record.explanation,
    hint: record.hint,
    isTransfer: Boolean(record.isTransfer),
    chapterId: record.chapterId,
    grade: record.grade,
    subjectId: record.subjectId,
    verificationStatus: record.verificationStatus,
  };
}

/** All approved questions for a curriculum, in the engine's shape. */
export function questionsForCurriculum(curriculumId) {
  const repo = getRepository();
  const approved = repo.listQuestions(curriculumId);
  return approved.length ? approved.map(normalizeQuestion) : questions;
}

function loadReferenceBank() {
  const repo = getRepository();
  const approved = repo.listQuestions(REFERENCE_CURRICULUM, { grade: REFERENCE_GRADE });
  if (approved.length === 0) {
    throw new Error(
      `Content pack "${REFERENCE_CURRICULUM}" contains no verified questions. ` +
      'Run `npm run curriculum:validate` in backend/.'
    );
  }
  return approved;
}

/** All approved questions for the reference curriculum, normalised. */
export const questions = loadReferenceBank().map(normalizeQuestion);

export const questionsById = Object.fromEntries(questions.map((q) => [q.qid, q]));
