/**
 * Strict Zod schema for Gemini lesson output, plus the domain rules that keep
 * the AI inside the approved curriculum.
 *
 * This is a backward-compatible extension of the Phase-2 lesson contract: the
 * existing fields (title, mindMap, steps, hint, tryNext, finalAnswer) still
 * exist, so existing consumers keep working.
 */

import { z } from 'zod';

const stepSchema = z
  .object({
    step: z.string().min(1).max(500),
    why: z.string().min(1).max(500),
  })
  .strict();

const workedExampleSchema = z
  .object({
    sourceExampleId: z.string().min(1).max(120),
    question: z.string().min(1).max(500),
    steps: z.array(stepSchema).min(1).max(8),
    finalAnswer: z.string().min(1).max(200),
  })
  .strict();

const mindMapSchema = z
  .object({
    focusConceptId: z.string().min(1).max(120),
    emphasizedConceptIds: z.array(z.string().min(1).max(120)).max(12),
    explanationLabels: z
      .array(
        z
          .object({
            conceptId: z.string().min(1).max(120),
            label: z.string().min(1).max(80),
          })
          .strict()
      )
      .max(12),
  })
  .strict();

export const lessonOutputSchema = z
  .object({
    conceptId: z.string().min(1).max(120),
    lessonType: z.enum([
      'targeted_review',
      'guided_practice',
      'worked_example',
      'concept_introduction',
      'challenge_explanation',
      'reexplanation',
    ]),
    title: z.string().min(1).max(120),
    learningObjective: z.string().min(1).max(240),
    explanation: z.string().min(1).max(3000),
    workedExample: workedExampleSchema,
    hint: z.string().min(1).max(800),
    tryNextQuestionId: z.string().min(1).max(120),
    mindMap: mindMapSchema,
    sourceIds: z.array(z.string().min(1).max(120)).max(12),
  })
  .strict();

export { stepSchema, workedExampleSchema, mindMapSchema };
