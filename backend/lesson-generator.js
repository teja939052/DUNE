/**
 * Lesson generator.
 *
 * Owns the policy around lesson generation: build server-controlled context,
 * call the configured provider, validate hard against the Zod schema AND the
 * domain rules, cache by non-personal keys, and fall back to the reviewed
 * lesson on any failure.
 *
 * The LLM is allowed to rephrase, re-sequence and re-label approved content.
 * It is never allowed to invent ids, change the worked answer, or decide
 * teaching order itself.
 */

import { getRepository, defaultCurriculumId } from './curriculum-context.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { lessonOutputSchema } from './lesson-schema.js';
import { validateLesson } from './lesson-validator.js';
import { reviewedFallbackLesson } from './fallback-lessons.js';
import { buildMindMap } from './engine.js';

/** Request-scoped cache. Keyed only on non-personal attributes. */
class LessonCache {
  constructor({ maxEntries = 200 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** Never put student names or long text in the key. */
  static key(context) {
    return [
      context.curriculumId,
      context.contentVersion,
      context.conceptId,
      context.misconception || '-',
      context.readingBand,
      context.language,
      context.lessonType,
      context.variant || 'default',
      PROMPT_VERSION,
    ].join('|');
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return null;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit;
  }

  set(key, value) {
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}

export class LessonGenerator {
  constructor({ providers, cache } = {}) {
    this.primary = providers?.primary || new GeminiProvider();
    this.fallback = providers?.fallback || null;
    this.cache = cache || new LessonCache();
    this.repo = getRepository();
  }

  providers() {
    return [this.primary, this.fallback].filter(Boolean);
  }

  /**
   * Generate a lesson for a policy action.
   * Always resolves — on any failure it returns the reviewed fallback with a
   * clear source and notice so the student journey never dead-ends.
   */
  async generate(context) {
    const curriculumId = context.curriculumId || defaultCurriculumId();
    const full = this.buildContext({ ...context, curriculumId });
    if (!full) {
      return { ok: false, reason: 'CONTEXT_UNAVAILABLE', lesson: null };
    }

    const key = LessonCache.key(full);
    const cached = this.cache.get(key);
    if (cached) {
      return { ok: true, lesson: { ...cached, fromCache: true }, provider: cached.source };
    }

    const providers = this.providers().filter((p) => p.isConfigured());
    if (providers.length === 0) {
      return this.#fallback(full, 'No teaching provider is configured.');
    }

    for (const provider of providers) {
      const result = await provider.generateLesson(full);
      if (result.ok) {
        const validation = validateLesson(result.lesson, full);
        if (validation.ok) {
          const lesson = validation.lesson;
          this.cache.set(key, lesson);
          return { ok: true, lesson, provider: provider.id };
        }
        console.warn(
          `[lesson] ${provider.id} output failed validation: ${validation.error}`,
          validation.details || ''
        );
        // Try the next provider before falling back.
        continue;
      }
      console.warn(`[lesson] ${provider.id} failed: ${result.code} ${result.error}`);
    }

    return this.#fallback(full, 'AI output could not be validated, so the reviewed lesson is shown.');
  }

  /** Turn the policy action into a validated, server-controlled lesson context. */
  buildContext(context) {
    const repo = this.repo;
    const curriculum = repo.getCurriculum(context.curriculumId);
    if (!curriculum) return null;

    const concept = repo.getConcept(context.curriculumId, context.conceptId);
    if (!concept) return null;

    const anchor = repo.getLessonAnchor(context.curriculumId, context.conceptId);
    if (!anchor) return null;

    const graph = buildMindMap(context.conceptId, context.model || null, context.curriculumId);
    const edges = graph.edges
      .map((e) => {
        const from = graph.nodes.find((n) => n.id === e.from);
        const to = graph.nodes.find((n) => n.id === e.to);
        return from && to ? `${from.label} -> ${to.label}` : null;
      })
      .filter(Boolean)
      .join('; ');

      // The next question is chosen by the deterministic engine, never by the LLM.
      const nextQuestionId = context.nextQuestionId || null;
      // Alias provided so the provider template can reference the approved id
      // rather than inventing one.
      const tryNextQuestionId = nextQuestionId;

    // Evidence snapshot for personalization (teaching HOW, never deciding WHAT).
    const skill = context.model?.skills?.[context.conceptId];
    const attempts = skill?.attempts || 0;
    const correct = skill?.correct || 0;
    const masteryEstimate = attempts === 0
      ? 'not yet measured'
      : `${Math.round((skill.mastery || 0) * 100)}% over ${attempts} attempt(s), ${correct} correct`;
    const recent = (context.model?.recentAttempts || []).slice(-4);
    const recentAttemptsSummary = recent.length === 0
      ? 'no attempts yet'
      : recent.map((a) => `${a.correct ? 'correct' : 'wrong'} on ${a.conceptId}`).join('; ');
    const misconceptionExplanation = context.misconception
      ? (repo.getMisconceptionExplanation(context.curriculumId, context.misconception) || context.misconception.replace(/-/g, ' '))
      : null;
    const failedApproach = context.misconception
      ? `repeated ${String(context.misconception).replace(/-/g, ' ')} error${skill?.consecutiveWrong ? ` (${skill.consecutiveWrong} in a row)` : ''}`
      : 'no systematic error observed yet';
    const anchorSteps = anchor.steps || [];
    const approvedAnchors = anchorSteps.length
      ? anchorSteps.map((s) => s.caption).join(' → ')
      : 'follow the reviewed worked example';

    return {
      curriculumId: context.curriculumId,
      board: curriculum.board,
      contentVersion: repo.contentVersion(context.curriculumId),
      conceptId: context.conceptId,
      conceptLabel: concept.title,
      learningObjective: (concept.learningObjectives && concept.learningObjectives[0]) || `Solve problems with ${concept.title}`,
      grade: context.grade,
      readingBand: context.readingBand,
      readingGuidance: context.readingGuidance,
      language: context.language || 'en',
      action: context.action,
      actionReason: context.actionReason,
      misconception: context.misconception || null,
      misconceptionExplanation,
      failedApproach,
      approvedAnchors,
      masteryEstimate,
      recentAttemptsSummary,
      variant: context.variant || 'default',
      lessonType: lessonTypeFor(context.action),
      conceptGraph: edges,
      nodeIdsHint: graph.nodes.map((n) => n.id).join(', '),
      allowedConceptIds: graph.nodes.map((n) => n.id),
      workedExample: {
        sourceExampleId: anchor.sourceExampleId || `${context.conceptId}-worked-example`,
        problem: anchor.workedExample.problem,
        finalAnswer: anchor.workedExample.finalAnswer,
      },
      sourceIds: concept.sourceIds && concept.sourceIds.length ? concept.sourceIds : curriculum.sourceIds,
      tryNextQuestionId,
      canonicalMindMap: graph,
      model: context.model || null,
      // The validator needs this to check ids against approved records.
      repo,
      policyVersion: context.policyVersion || null,
    };
  }

  #fallback(context, reason) {
    const lesson = reviewedFallbackLesson(context, this.repo);
    const key = LessonCache.key(context);
    // Fallbacks are cheap to rebuild, so they are not cached: they must always
    // reflect the current canonical graph and version.
    console.warn(`[lesson] using reviewed fallback (${reason})`);
    return { ok: true, lesson, provider: 'fallback', notice: reason, fallback: true };
  }

  cacheStats() {
    return this.cache.stats();
  }
}

/** Bump when the teaching prompt changes so stale cached lessons are not reused. */
export const PROMPT_VERSION = 2;

/** Map a policy action code onto the schema's lessonType enum. */
export function lessonTypeFor(action) {
  switch (action) {
    case 'prerequisite-review':
    case 'targeted-review':
      return 'targeted_review';
    case 'guided-practice':
      return 'guided_practice';
    case 'harder-challenge':
      return 'challenge_explanation';
    case 'misconception-repair':
      return 'reexplanation';
    default:
      return 'worked_example';
  }
}
