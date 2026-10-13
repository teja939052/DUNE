/**
 * Gemini teaching provider.
 *
 * Transport and configuration only: it knows how to call Gemini with a
 * structured-output schema and how to classify failures. It contains no
 * adaptation rules, no prompt policy and no validation — those belong to the
 * lesson generator.
 */

import { TeachingProvider, ProviderError, PROVIDER_FAILURE } from './interface.js';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Generic structured-output schema. Strings only — the app's Zod schema is what
 * actually enforces shape and bounds, because the provider cannot be trusted to
 * enforce our domain limits.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    conceptId: { type: 'string' },
    lessonType: {
      type: 'string',
      enum: [
        'targeted_review',
        'guided_practice',
        'worked_example',
        'concept_introduction',
        'challenge_explanation',
        'reexplanation',
      ],
    },
    title: { type: 'string' },
    learningObjective: { type: 'string' },
    explanation: { type: 'string' },
    workedExample: {
      type: 'object',
      properties: {
        sourceExampleId: { type: 'string' },
        question: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['step', 'why'],
          },
        },
        finalAnswer: { type: 'string' },
      },
      required: ['sourceExampleId', 'question', 'steps', 'finalAnswer'],
    },
    hint: { type: 'string' },
    tryNextQuestionId: { type: 'string' },
    mindMap: {
      type: 'object',
      properties: {
        focusConceptId: { type: 'string' },
        emphasizedConceptIds: { type: 'array', items: { type: 'string' } },
        explanationLabels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              conceptId: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['conceptId', 'label'],
          },
        },
      },
      required: ['focusConceptId', 'emphasizedConceptIds', 'explanationLabels'],
    },
    sourceIds: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'conceptId',
    'lessonType',
    'title',
    'learningObjective',
    'explanation',
    'workedExample',
    'hint',
    'tryNextQuestionId',
    'mindMap',
    'sourceIds',
  ],
};

export class GeminiProvider extends TeachingProvider {
  constructor(options = {}) {
    super();
    this.id = 'gemini';
    this.model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.timeoutMs = Number(options.timeoutMs || process.env.GEMINI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.maxOutputTokens = options.maxOutputTokens || 1600;
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /** Failure telemetry without ever logging the key or student text. */
  static classify(status, body) {
    if (status === 401 || status === 403) return PROVIDER_FAILURE.AUTH_FAILED;
    if (status === 429) return PROVIDER_FAILURE.RATE_LIMITED;
    if (status === 400) {
      // Google distinguishes an invalid key from a bad request in the body.
      if (/api[_ ]?key/i.test(body || '')) return PROVIDER_FAILURE.AUTH_FAILED;
    }
    if (status >= 500) return PROVIDER_FAILURE.UNKNOWN;
    return PROVIDER_FAILURE.INVALID_RESPONSE;
  }

  async generateLesson(request) {
    if (!this.isConfigured()) {
      return new ProviderError(PROVIDER_FAILURE.NOT_CONFIGURED, 'GEMINI_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text:
                    'You are AhaPath, a patient, precise, age-appropriate personal tutor for school students. ' +
                    'MISSION: Teach the single approved concept in the input so the learner can solve a fresh problem independently. ' +
                    'Personalize from the demonstrated evidence; do not restate textbook material or produce a long essay. ' +
                    'SOURCE AND SCOPE: The supplied curriculum facts, concept IDs, prerequisite graph, lesson anchors and worked examples are the source of truth. ' +
                    'Do not invent syllabus requirements, citations, source IDs, resource URLs, prerequisite edges, concept IDs or board claims. ' +
                    'Teach only the requested concept and the minimum required prerequisite. ' +
                    'Do not change the deterministic engine action. You write teaching content for that action; you never decide mastery, grade attempts, select questions or promote topics. ' +
                    'PERSONALIZATION: Follow the grade and language exactly, with short sentences and concrete examples. ' +
                    'Address the reasoning error respectfully, never the student ability. ' +
                    'Use an explanation style that differs from the failed approach (balance-scale visual, everyday analogy, or worked steps). ' +
                    'Teach one idea at a time; every step states what to do and why; verify all arithmetic. ' +
                    'STRUCTURE: one measurable objective; short intuition first; small relationship map; justified worked example; explicit misconception correction; ' +
                    'one graduated hint for a new question (never the full answer); one short transfer check. Never claim mastery from a generated lesson. ' +
                    'OUTPUT: only JSON matching the supplied schema. No fences, preamble, extra keys or unvalidated IDs. If context is insufficient, repeat exactly the supplied worked example and final answer.',
                },
              ],
            },
            contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
              temperature: 0.3,
              maxOutputTokens: this.maxOutputTokens,
            },
          }),
          signal: controller.signal,
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const code = GeminiProvider.classify(res.status, body);
        return new ProviderError(
          code,
          `Gemini HTTP ${res.status}: ${body.slice(0, 200)}`
        );
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const reason =
          data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
        return new ProviderError(
          PROVIDER_FAILURE.INVALID_RESPONSE,
          `Gemini returned no text${reason ? ` (${reason})` : ''}`
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return new ProviderError(PROVIDER_FAILURE.INVALID_RESPONSE, 'response was not valid JSON');
      }

      return { ok: true, lesson: parsed, provider: this.id };
    } catch (err) {
      if (err?.name === 'AbortError') {
        return new ProviderError(
          PROVIDER_FAILURE.TIMEOUT,
          `Gemini timed out after ${this.timeoutMs}ms`
        );
      }
      return new ProviderError(PROVIDER_FAILURE.UNKNOWN, err?.message || String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildPrompt(request) {
  const styleLine = request.variant === 'analogy'
    ? 'STYLE REQUEST: the student asked for a different explanation. Use an everyday analogy first, then map it back to the steps. Do not repeat the previous wording.'
    : request.variant === 'steps'
    ? 'STYLE REQUEST: the student asked for a different explanation. Use tight worked steps with a reason for every move, minimal analogy.'
    : 'STYLE: balance a short intuition with clear worked steps.';
  const lines = [
    'Teach ONE concept to ONE learner with an observed gap. Work only from the lesson facts below.',
    '',
    '=== LEARNER ===',
    `- Board/curriculum: ${request.board || request.curriculumId} (${request.grade}, ${request.readingBand} reading band)`,
    `- Reading guidance: ${request.readingGuidance}`,
    `- Language: ${request.language === 'hi' ? 'simple Hindi (Devanagari)' : 'English'}`,
    `- Mastery estimate for ${request.conceptLabel}: ${request.masteryEstimate}`,
    `- Recent attempts: ${request.recentAttemptsSummary}`,
    `- Style: ${styleLine}`,
    '',
    '=== WHY THIS LESSON (server-decided, do not contradict) ===',
    `- Concept: ${request.conceptLabel} (${request.conceptId})`,
    `- Learning objective: ${request.learningObjective}`,
    `- Policy action: ${request.action}`,
    `- Reason: ${request.actionReason}`,
    `- Detected misconception: ${request.misconception || 'none'}`,
    `- What the error means: ${request.misconceptionExplanation || 'n/a'}`,
    `- Failed approach to differ from: ${request.failedApproach}`,
    '',
    '=== APPROVED FACTS (verified, do not contradict) ===',
    `- Worked example: ${request.workedExample.problem}`,
    `- Final answer (must match exactly, same format): ${request.workedExample.finalAnswer}`,
    `- Approved teaching moves: ${request.approvedAnchors}`,
    '',
    '=== CANONICAL CONCEPT GRAPH ===',
    request.conceptGraph,
    `- Allowed node ids: ${request.nodeIdsHint}`,
    '',
    '=== REQUIREMENTS ===',
    `- conceptId must be exactly "${request.conceptId}".`,
    `- lessonType must be one of the allowed values, matching the action above.`,
    `- The explanation must suit the ${request.readingBand} reading band.`,
    `- 3 to 5 worked steps. Each step needs the operation (step) and the reason (why).`,
    `- The hint must guide, never give the answer away.`,
    `- tryNextQuestionId must be exactly "${request.tryNextQuestionId}" — do not invent one.`,
    `- mindMap.focusConceptId must be "${request.conceptId}".`,
    `- mindMap.emphasizedConceptIds may only contain ids from the allowed list.`,
    `- mindMap.explanationLabels may only label allowed concepts.`,
    `- sourceIds must be exactly: ${request.sourceIds.join(', ')}`,
    `- finalAnswer must be exactly "${request.workedExample.finalAnswer}".`,
  ];
  return lines.join('\n');
}
