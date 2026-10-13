/**
 * Curriculum data model — Zod schemas for every content-pack entity.
 *
 * These schemas are the contract for every pack on disk. Validation reports the
 * filename and record ID for each error so a broken pack is easy to locate.
 */

import { z } from 'zod';

export const COVERAGE = ['catalog_only', 'lesson_ready', 'assessment_ready', 'reviewed', 'retired'];

export const REVIEW_STATUS = ['unverified', 'pending_review', 'reviewed', 'verified', 'rejected'];

const idSchema = z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'IDs must be simple slugs');

export const sourceSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(200),
  issuingOrganisation: z.string().min(1).max(120),
  url: z.string().url().max(500).optional(),
  fileReference: z.string().max(300).optional(),
  edition: z.string().max(80).optional(),
  academicYear: z.string().max(40).optional(),
  language: z.string().min(2).max(10),
  retrievalDate: z.string().date().optional(),
  reviewStatus: z.enum(REVIEW_STATUS),
  notes: z.string().max(500).optional(),
});

export const curriculumSchema = z
  .object({
    id: idSchema,
    region: z.string().min(2).max(40),
    board: z.string().min(1).max(80),
    academicYear: z.string().min(4).max(40),
    defaultLanguage: z.string().min(2).max(10),
    supportedGrades: z.array(z.number().int().min(1).max(12)).min(1),
    languages: z.array(z.string().min(2).max(10)).min(1).default(['en']),
    sourceIds: z.array(idSchema).min(1),
    contentVersion: z.number().int().min(1),
    status: z.enum(['active', 'draft', 'retired']).default('active'),
  })
  .strict();

export const subjectSchema = z
  .object({
    id: idSchema,
    curriculumId: idSchema,
    grade: z.number().int().min(1).max(12),
    title: z.string().min(1).max(120),
    order: z.number().int().min(0),
    coverage: z.enum(COVERAGE),
    note: z.string().max(400).optional(),
  })
  .strict();

export const chapterSchema = z
  .object({
    id: idSchema,
    curriculumId: idSchema,
    grade: z.number().int().min(1).max(12),
    subjectId: idSchema,
    title: z.string().min(1).max(160),
    order: z.number().int().min(0),
    coverage: z.enum(COVERAGE),
    summary: z.string().max(400).optional(),
    version: z.number().int().min(1),
  })
  .strict();

export const conceptSchema = z
  .object({
    id: idSchema,
    curriculumId: idSchema,
    grade: z.number().int().min(1).max(12),
    subjectId: idSchema,
    chapterId: idSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(400).optional(),
    learningObjectives: z.array(z.string().max(240)).max(8).default([]),
    prerequisiteConceptIds: z.array(idSchema).max(12).default([]),
    recommendedDifficulty: z.number().int().min(1).max(4),
    estimatedMinutes: z.number().int().min(1).max(600).optional(),
    sourceIds: z.array(idSchema).default([]),
    version: z.number().int().min(1),
  })
  .strict();

export const questionSchema = z
  .object({
    id: idSchema,
    curriculumId: idSchema,
    grade: z.number().int().min(1).max(12),
    subjectId: idSchema,
    chapterId: idSchema,
    conceptId: idSchema,
    difficulty: z.number().int().min(1).max(4),
    type: z.enum(['multiple-choice']),
    prompt: z.string().min(1).max(600),
    options: z
      .array(
        z
          .object({
            id: idSchema,
            text: z.string().min(1).max(300),
          })
          .strict()
      )
      .min(2)
      .max(6),
    correctOptionId: idSchema,
    misconceptionByOption: z.record(z.string(), z.string().max(80)).default({}),
    explanation: z.string().min(1).max(600),
    hint: z.string().max(400).optional(),
    isTransfer: z.boolean().default(false),
    sourceIds: z.array(idSchema).default([]),
    verificationStatus: z.enum(REVIEW_STATUS),
    version: z.number().int().min(1),
  })
  .strict()
  .refine((q) => q.options.some((o) => o.id === q.correctOptionId), {
    message: 'correctOptionId must be one of the options',
    path: ['correctOptionId'],
  })
  .refine((q) => new Set(q.options.map((o) => o.id)).size === q.options.length, {
    message: 'option ids must be unique',
    path: ['options'],
  });

export const resourceSchema = z
  .object({
    id: idSchema,
    curriculumId: idSchema,
    grade: z.number().int().min(1).max(12),
    subjectId: idSchema,
    type: z.enum(['lesson', 'video', 'diagram', 'reading', 'worksheet', 'external_link']),
    title: z.string().min(1).max(200),
    language: z.string().min(2).max(10),
    url: z.string().url().max(500).optional(),
    contentRef: z.string().max(300).optional(),
    publisher: z.string().max(200).optional(),
    licence: z.string().max(400).optional(),
    reviewStatus: z.enum(REVIEW_STATUS),
    conceptIds: z.array(idSchema).max(24).default([]),
    version: z.number().int().min(1),
  })
  .strict()
  .refine((r) => Boolean(r.url || r.contentRef), {
    message: 'a resource needs a verified URL or an internal content reference',
    path: ['url'],
  });

export const packManifestSchema = z
  .object({
    curriculum: curriculumSchema,
    sources: z.array(sourceSchema).min(1),
    packs: z
      .array(
        z.object({
          grade: z.number().int().min(1).max(12),
          subjectId: idSchema,
          path: z.string().min(1).max(200),
        })
      )
      .min(1),
    contentVersion: z.number().int().min(1),
    generatedAt: z.string().datetime().optional(),
    provenanceNotes: z.array(z.string().max(500)).default([]),
  })
  .strict();

export const SCHEMAS = {
  sources: sourceSchema,
  subjects: subjectSchema,
  chapters: chapterSchema,
  concepts: conceptSchema,
  questions: questionSchema,
  resources: resourceSchema,
};
