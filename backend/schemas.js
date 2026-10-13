/**
 * Strict validation for the Gemini lesson payload.
 *
 * Every field is validated before rendering, unexpected properties are
 * rejected, and the final worked-example answer is checked against the
 * canonical server-side answer before the lesson is trusted.
 */

import { z } from 'zod';

export const lessonSchema = z.object({
  title: z
    .string()
    .min(3, 'Lesson title is too short')
    .max(120, 'Lesson title is too long'),
  mindMap: z
    .object({
      nodes: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1).max(60),
            type: z.enum(['prerequisite', 'current', 'target', 'remediation']),
          })
        )
        .min(3, 'A lesson mind map needs at least 3 nodes')
        .max(12, 'Too many mind map nodes'),
      edges: z
        .array(
          z.object({
            from: z.string().min(1),
            to: z.string().min(1),
          })
        )
        .min(2, 'A mind map needs at least 2 edges')
        .max(16, 'Too many mind map edges'),
    })
    .strict(),
  imageQuery: z
    .string()
    .min(3)
    .max(160,
      'The MVP does not fetch external images; this is descriptive only'),
  steps: z
    .array(
      z.object({
        caption: z.string().min(1).max(80),
        content: z.string().min(1).max(400),
        why: z.string().min(1).max(300),
      })
    )
    .min(2, 'A lesson needs at least 2 steps')
    .max(8, 'Too many lesson steps'),
  hint: z.string().min(5).max(240),
  tryNext: z
    .string()
    .min(3, 'A lesson must say what to try next')
    .max(240),
  finalAnswer: z.string().min(1).max(60),
}).strict();

/** Validate a lesson payload and check the worked-example answer. */
export function validateLesson(payload, expectedFinalAnswer) {
  const parsed = lessonSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Lesson failed schema validation',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const lesson = parsed.data;
  if (expectedFinalAnswer) {
    const normalizedActual = normalizeAnswer(lesson.finalAnswer);
    const normalizedExpected = normalizeAnswer(expectedFinalAnswer);
    if (normalizedActual !== normalizedExpected) {
      return {
        ok: false,
        error: 'Final answer did not match the canonical expected answer',
        details: {
          got: lesson.finalAnswer,
          expected: expectedFinalAnswer,
        },
      };
    }
  }
  return { ok: true, lesson };
}

/** Compare answers ignoring case, spaces and stray formatting. */
function normalizeAnswer(value) {
  return String(value)
    .toLowerCase()
    .replace(/[{}`]/g, '')
    .replace(/\s+/g, '')
    .replace(/\\[left|right]/g, '')
    .replace(/×|\\times/g, '*')
    .replace(/÷|\\div/g, '/');
}

/** Request validation schemas for the API surface. */
export const sessionCreateSchema = z.object({
  nickname: z.string().min(1).max(30),
  class: z.number().int().min(5).max(10),
  subject: z.string().min(1).max(40),
  chapter: z.string().min(1).max(60),
  language: z.enum(['en']).default('en'),
  curriculumId: z.string().min(1).max(120).optional(),
});

export const answerSchema = z.object({
  questionId: z.string().min(1),
  optionId: z.string().min(1).max(60),
  usedHint: z.boolean().optional(),
});

export const lessonRequestSchema = z.object({
  conceptId: z.string().min(1).max(60),
  action: z.string().min(1).max(40),
  nextQuestionId: z.string().min(1).max(60).optional(),
  variant: z.enum(['default', 'analogy', 'steps']).optional(),
});

/** Platform auth validation (demo auth — honest limits documented in auth.js). */
export const authRegisterSchema = z.object({
  name: z.string().min(1).max(30),
  email: z.string().min(3).max(120),
  password: z.string().min(6).max(128),
  grade: z.number().int().min(5).max(10),
});

export const authLoginSchema = z.object({
  email: z.string().min(3).max(120),
  password: z.string().min(1).max(128),
});
