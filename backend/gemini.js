/**
 * Gemini integration.
 *
 * The key lives only in the backend environment and is never sent to the
 * browser. Every call has a hard timeout, and any failure (missing key,
 * network error, timeout, refusals, malformed JSON) surfaces as an error so the
 * caller can fall back to the reviewed lesson.
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Build the structured-output response schema handed to Gemini. Kept generic
 * (untyped) so the model returns strings we validate ourselves with Zod.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    mindMap: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['prerequisite', 'current', 'target', 'remediation'] },
            },
            required: ['id', 'label', 'type'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['nodes', 'edges'],
    },
    imageQuery: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          caption: { type: 'string' },
          content: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['caption', 'content', 'why'],
      },
    },
    hint: { type: 'string' },
    tryNext: { type: 'string' },
    finalAnswer: { type: 'string' },
  },
  required: ['title', 'mindMap', 'imageQuery', 'steps', 'hint', 'tryNext', 'finalAnswer'],
};

/**
 * Request a personalised lesson.
 *
 * `facts` is server-controlled: the worked example, the canonical answer and
 * the student's observed evidence. The prompt forbids the model from inventing
 * a different problem or a different answer.
 *
 * @returns {Promise<{ok: true, lesson: object, source: 'gemini'} | {ok: false, error: string}>}
 */
export async function generateLessonWithGemini({ facts, promptExtras }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'GEMINI_API_KEY is not configured' };
  }

  const prompt = buildPrompt(facts, promptExtras);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text:
                  'You are AhaPath, a patient maths tutor for Indian school students. ' +
                  'You write short, clear, accurate steps. You never change the problem ' +
                  'or the answer. If you are unsure of the answer, repeat exactly the ' +
                  'answer given in the lesson facts.',
              },
            ],
          },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
            maxOutputTokens: 1400,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Gemini HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
      return { ok: false, error: `Gemini returned no text${reason ? ` (${reason})` : ''}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Gemini response was not valid JSON' };
    }

    return { ok: true, lesson: parsed, source: 'gemini' };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: `Gemini timed out after ${GEMINI_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `Gemini request failed: ${err?.message || String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(facts, extras) {
  return [
    'Write ONE structured visual lesson for the student described below.',
    'Work from the supplied lesson facts only. Do not invent a new problem.',
    '',
    '=== STUDENT ===',
    `- Class: ${facts.class} (${facts.bandName} reading band)`,
    `- Reading guidance: ${facts.bandGuidance}`,
    `- Concept: ${facts.conceptLabel}`,
    `- Reason for this lesson: ${facts.actionReason}`,
    `- Practice outcome: ${facts.practiceOutcome}`,
    '',
    '=== LESSON FACTS (server-verified, do not contradict) ===',
    `- Worked example problem: ${facts.problem}`,
    `- Final answer (must match exactly, same format): ${facts.expectedFinalAnswer}`,
    '',
    '=== CONCEPT GRAPH ===',
    facts.conceptGraph,
    '',
    '=== REQUIREMENTS ===',
    `- The mind map must use exactly these node ids: ${facts.nodeIdsHint}.`,
    '- The first edge must be a prerequisite pointing at the current concept.',
    `- 3 to 5 numbered steps. Each step needs a caption, the operation, and why.`,
    `- The hint must guide, never give the answer away.`,
    `- tryNext tells the student what to try next.`,
    `- finalAnswer must be exactly "${facts.expectedFinalAnswer}".`,
    `- Write for the reading band: ${facts.bandGuidance}`,
    '',
    '=== LANGUAGE ===',
    facts.language === 'hi'
      ? 'Write in simple Hindi (Devanagari). Keep maths notation in Latin/Arabic numerals.'
      : 'Write in English.',
  ]
    .filter(Boolean)
    .join('\n');
}
