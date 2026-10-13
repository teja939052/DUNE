/**
 * Curriculum context wiring.
 *
 * Gives the deterministic engine and the API access to the single loaded
 * repository without threading it through every function signature, and
 * without any module importing Mongoose or Express.
 */

import { loadRepository } from './curriculum/repository.js';

let instance = null;

/** Load (once) and return the shared repository. */
export function getRepository() {
  if (!instance) {
    instance = loadRepository();
    if (instance.loadErrors.length > 0) {
      console.error(
        `[curriculum] ${instance.loadErrors.length} content pack error(s). Run \`npm run curriculum:validate\`.`
      );
    }
  }
  return instance;
}

/** Convenience alias used by the engine. */
export const getMisconceptionRepository = getRepository;

/** The curriculum the app is currently configured to serve. */
export function defaultCurriculumId() {
  const repo = getRepository();
  const first = repo.listCurricula()[0];
  return first ? first.id : null;
}
