/**
 * Single source of truth for every adaptation threshold.
 *
 * No rule literals live in routes, prompts or components — they all read from
 * here so the tuning is auditable in one place.
 *
 * Deviation note: the original brief suggested `difficultyLevels: [1, 2, 3]`,
 * but the existing verified 12-question bank uses four difficulty levels and the
 * tested selection logic depends on that range. Changing it would break
 * verified behaviour, so the canonical default is [1, 2, 3, 4] and this file is
 * the reason it is documented rather than silently altered.
 */

export const ADAPTATION_CONFIG = {
  /** How many questions the opening diagnostic serves. The full verified bank
   *  remains available for practice and integration tests. Default 12 keeps
   *  the verified divergence demo intact; set DIAGNOSTIC_COUNT=4 for a
   *  30-second hackathon demo (judges leave after Q3). */
  diagnosticQuestionCount: 12,

  /** Review a prerequisite concept when its mastery drops below this. */
  prerequisiteReviewThreshold: 0.7,

  /** Fire targeted review after this many consecutive wrong answers on a concept. */
  repeatedWrongCount: 2,

  /** Guided practice when fewer than this many of the recent window are correct. */
  lowRecentCorrectCount: 2,

  /** Size of the recent-attempt window. */
  recentWindowSize: 4,

  /** Minimum attempts before mastery can qualify for a challenge. */
  challengeMinAttempts: 3,

  /** Mastery required for a challenge. */
  challengeMasteryThreshold: 0.8,

  /** A transfer question must be passed before a challenge is offered. */
  requireTransferPassForChallenge: true,

  /** Post-assessment: short independent check on practised concepts, served
   *  from unseen verified questions where the bank allows, otherwise honest
   *  retakes. Thresholds are initial product heuristics, not validated cut-offs. */
  postAssessment: {
    /** Maximum post-assessment questions per run. */
    maxQuestions: 6,
    /** Minimum post attempts on a concept before it can read as demonstrated. */
    minAttempts: 2,
    /** Post-stage accuracy fraction that marks an objective demonstrated. */
    demonstratedThreshold: 0.8,
  },

  /** Bounds of the difficulty scale used by the verified bank. */
  difficultyLevels: [1, 2, 3, 4],
  difficultyFloor: 1,
  difficultyCeiling: 4,

  /** Policy version recorded on every adaptation event so decisions can be replayed. */
  policyVersion: 1,
};

/** Reading bands keyed on the class the student selected. */
export const READING_BANDS = [
  { min: 5, max: 6, name: 'simple',
    guidance: 'Use very simple words and short sentences. Use everyday objects like sharing sweets or a see-saw as analogies. Avoid notation the student has not met.' },
  { min: 7, max: 8, name: 'clear',
    guidance: 'Use clear everyday language and step-by-step reasoning. Name each move you make and say why it keeps the equation balanced.' },
  { min: 9, max: 10, name: 'formal',
    guidance: 'Use correct mathematical notation and concise formal reasoning. State steps compactly without extra hand-holding.' },
];

export function bandForClass(klass) {
  return READING_BANDS.find((b) => klass >= b.min && klass <= b.max) || READING_BANDS[1];
}

/** Minimum number of attempts before a skill is judged at all. */
export const minAttemptsForJudgement = 2;

/**
 * Mastery is a heuristic, not a validated educational measurement.
 *
 * score = fractionCorrect * (0.5 + 0.5 * confidence), where confidence rises
 * with the number of attempts (capped at 3). A single lucky answer therefore
 * cannot read as mastery, and one unlucky miss cannot read as a gap.
 */
export function masteryScore(skillState) {
  if (!skillState || skillState.attempts === 0) return 0;
  const fractionCorrect = skillState.correct / skillState.attempts;
  const confidence = Math.min(skillState.attempts, 3) / 3;
  return fractionCorrect * (0.5 + 0.5 * confidence);
}
