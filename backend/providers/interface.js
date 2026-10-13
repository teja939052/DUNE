/**
 * TeachingProvider — the provider-independent contract.
 *
 * Routes, the adaptation policy, database code and React components never talk
 * to a vendor SDK directly. They talk to this interface.
 */

/**
 * @typedef {object} LessonRequest
 * @property {string} conceptId
 * @property {string} curriculumId
 * @property {number} contentVersion
 * @property {number} grade
 * @property {string} readingBand            band name: simple | clear | formal
 * @property {string} readingGuidance        band guidance text
 * @property {string} language
 * @property {string} actionReason           deterministic, server-authored reason
 * @property {string} action                 the policy action code
 * @property {string} misconception          detected misconception code, if any
 * @property {string} conceptLabel
 * @property {string} conceptGraph           canonical prerequisite edges as text
 * @property {string} nodeIdsHint            canonical node ids
 * @property {{problem:string, finalAnswer:string}} workedExample  approved facts
 * @property {string[]} sourceIds
 */

/** Shared failure vocabulary. Providers must map their errors onto these. */
export const PROVIDER_FAILURE = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  UNKNOWN: 'UNKNOWN',
};

export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

/**
 * A provider returns { ok: true, lesson } or { ok: false, code, error }.
 * It never throws, so the caller always has a branchable failure.
 */
export class TeachingProvider {
  /** @type {string} provider id, e.g. "gemini" */
  id = 'abstract';

  /** @returns {boolean} whether credentials are present */
  isConfigured() {
    throw new Error('not implemented');
  }

  /**
   * @param {LessonRequest} request
   * @returns {Promise<{ok: true, lesson: object} | {ok: false, code: string, error: string}>}
   */
  async generateLesson(_request) {
    throw new Error('not implemented');
  }
}
