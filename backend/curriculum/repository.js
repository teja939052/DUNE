/**
 * Curriculum repository.
 *
 * Loads version-controlled content packs from disk at startup and serves them
 * through a read-only, scoped API. This is deliberately NOT the database: packs
 * are reviewed source data, while student progress is mutable state.
 *
 * Packs are the source of truth, so no credentials are needed and local
 * development can never be blocked by an external service.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMAS, packManifestSchema } from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = process.env.CONTENT_PACK_ROOT || join(HERE, '..', '..', 'content-packs');

class CurriculumRepository {
  constructor({ packRoot } = {}) {
    this.packRoot = packRoot || PACK_ROOT;
    /** curriculumId -> record */
    this.curricula = new Map();
    /** sourceId -> record */
    this.sources = new Map();
    /** `${curriculumId}|${grade}|${subjectId}` -> subject */
    this.subjects = new Map();
    /** chapterId -> chapter */
    this.chapters = new Map();
    /** conceptId -> concept (scoped by curriculum) */
    this.concepts = new Map();
    /** questionId -> question (scoped by curriculum) */
    this.questions = new Map();
    /** resourceId -> resource */
    this.resources = new Map();
    /** `${curriculumId}|${grade}|${subjectId}` -> chapterIds */
    this.chaptersByScope = new Map();
    /** `${chapterId}` -> conceptIds */
    this.conceptsByChapter = new Map();
    /** `${conceptId}` -> questionIds */
    this.questionsByConcept = new Map();
    /** `${conceptId}` -> resourceIds */
    this.resourcesByConcept = new Map();
    /** conceptId -> prerequisite concept ids */
    this.edges = new Map();
    /** `${curriculumId}|${conceptId}` -> misconception explanation */
    this.misconceptions = new Map();
    /** `${curriculumId}|${conceptId}` -> reviewed lesson anchor */
    this.lessonAnchors = new Map();
    /** Errors from the last load. */
    this.loadErrors = [];
    this.contentVersionByCurriculum = new Map();
  }

  /** Discover and load every pack under the content-packs root. */
  load() {
    this.loadErrors = [];
    if (!existsSync(this.packRoot)) {
      this.loadErrors.push({ path: this.packRoot, error: 'content-packs root not found' });
      return this;
    }

    const stack = [this.packRoot];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        this.loadErrors.push({ path: dir, error: err.message });
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name === 'pack.json') {
          this.#loadPack(full);
        }
      }
    }
    return this;
  }

  #loadPack(manifestPath) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      this.loadErrors.push({ path: manifestPath, error: `invalid JSON: ${err.message}` });
      return;
    }

    const parsed = packManifestSchema.safeParse(raw);
    if (!parsed.success) {
      this.loadErrors.push({
        path: manifestPath,
        error: 'manifest schema invalid',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }

    const manifest = parsed.data;
    const baseDir = dirname(manifestPath);
    const { curriculum } = manifest;

    // Validate that the declared curriculum is self-consistent.
    for (const sourceId of curriculum.sourceIds) {
      if (!manifest.sources.some((s) => s.id === sourceId)) {
        this.loadErrors.push({ path: manifestPath, id: curriculum.id, error: `unknown sourceId "${sourceId}"` });
      }
    }

    this.curricula.set(curriculum.id, curriculum);
    this.contentVersionByCurriculum.set(curriculum.id, manifest.contentVersion);
    for (const s of manifest.sources) this.sources.set(s.id, s);

    for (const declared of manifest.packs) {
      this.#loadPackDir(baseDir, declared.path, curriculum.id);
    }
  }

  #loadPackDir(baseDir, relPath, curriculumId) {
    const dir = join(baseDir, relPath);
    if (!existsSync(dir)) {
      this.loadErrors.push({ path: dir, error: 'pack directory listed in manifest not found' });
      return;
    }

    // Subject records can live beside the pack or one level up (grade level).
    const seenSubjects = new Set();
    for (const subject of this.#findSubjects(dir)) {
      const key = `${subject.curriculumId}|${subject.grade}|${subject.id}`;
      if (seenSubjects.has(key)) continue;
      seenSubjects.add(key);
      this.#put(this.subjects, key, subject, 'subjects', SCHEMAS.subjects);
    }
    for (const catalogue of this.#readArray(join(dir, 'catalogue.json')) ?? []) {
      const key = `${catalogue.curriculumId}|${catalogue.grade}|${catalogue.id}`;
      if (seenSubjects.has(key)) continue;
      seenSubjects.add(key);
      this.#put(this.subjects, key, catalogue, 'subjects', SCHEMAS.subjects);
    }

    for (const chapter of this.#readArray(join(dir, 'chapters.json')) ?? []) {
      this.#put(this.chapters, chapter.id, chapter, 'chapters', SCHEMAS.chapters);
      const key = `${curriculumId}|${chapter.grade}|${chapter.subjectId}`;
      const list = this.chaptersByScope.get(key) ?? [];
      list.push(chapter.id);
      this.chaptersByScope.set(key, list);
    }

    const conceptsFile = this.#readArray(join(dir, 'concepts.json'));
    for (const concept of conceptsFile ?? []) {
      this.#put(this.concepts, concept.id, concept, 'concepts', SCHEMAS.concepts);
      const key = `${curriculumId}|${concept.grade}|${concept.subjectId}|${concept.chapterId}`;
      const list = this.conceptsByChapter.get(key) ?? [];
      list.push(concept.id);
      this.conceptsByChapter.set(key, list);
      this.edges.set(concept.id, concept.prerequisiteConceptIds || []);
      for (const sourceId of concept.sourceIds || []) {
        if (!this.sources.has(sourceId)) {
          this.loadErrors.push({ path: dir, error: `concept ${concept.id} references unknown source ${sourceId}` });
        }
      }
      for (const prereq of concept.prerequisiteConceptIds || []) {
        if (prereq === concept.id) {
          this.loadErrors.push({ path: dir, id: concept.id, error: 'concept lists itself as a prerequisite' });
        }
      }
    }
    // Detect cycles in the prerequisite graph.
    for (const conceptId of this.concepts.keys()) {
      if (this.#hasCycle(conceptId)) {
        this.loadErrors.push({ path: dir, id: conceptId, error: 'prerequisite graph contains a cycle' });
      }
    }

    for (const question of this.#readArray(join(dir, 'questions.json')) ?? []) {
      const parsed = SCHEMAS.questions.safeParse(question);
      if (!parsed.success) {
        this.loadErrors.push({
          path: join(dir, 'questions.json'),
          id: question.id,
          error: 'question schema invalid',
          details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }
      const q = parsed.data;
      if (!this.concepts.has(q.conceptId)) {
        this.loadErrors.push({ path: join(dir, 'questions.json'), id: q.id, error: `unknown conceptId "${q.conceptId}"` });
        continue;
      }
      const list = this.questionsByConcept.get(q.conceptId) ?? [];
      list.push(q.id);
      this.questionsByConcept.set(q.conceptId, list);
      this.questions.set(q.id, q);
      for (const sourceId of q.sourceIds || []) {
        if (!this.sources.has(sourceId)) {
          this.loadErrors.push({ path: join(dir, 'questions.json'), id: q.id, error: `unknown sourceId "${sourceId}"` });
        }
      }
    }

    for (const resource of this.#readArray(join(dir, 'resources.json')) ?? []) {
      const parsed = SCHEMAS.resources.safeParse(resource);
      if (!parsed.success) {
        this.loadErrors.push({
          path: join(dir, 'resources.json'),
          id: resource.id,
          error: 'resource schema invalid',
          details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }
      const r = parsed.data;
      this.resources.set(r.id, r);
      for (const conceptId of r.conceptIds || []) {
        if (!this.concepts.has(conceptId)) {
          this.loadErrors.push({ path: join(dir, 'resources.json'), id: r.id, error: `unknown conceptId "${conceptId}"` });
          continue;
        }
        const list = this.resourcesByConcept.get(conceptId) ?? [];
        list.push(r.id);
        this.resourcesByConcept.set(conceptId, list);
      }
    }

    const misconceptions = this.#readObject(join(dir, 'misconceptions.json'));
    if (misconceptions) {
      for (const [code, text] of Object.entries(misconceptions)) {
        this.misconceptions.set(`${curriculumId}|${code}`, text);
      }
    }

    const anchors = this.#readObject(join(dir, 'lesson-anchors.json'));
    if (anchors) {
      for (const [conceptId, anchor] of Object.entries(anchors)) {
        this.lessonAnchors.set(`${curriculumId}|${conceptId}`, anchor);
      }
    }
  }

  /**
   * Find subject records for a pack directory by looking in the directory and
   * then walking up to the curriculum root. Grade-level files win over
   * curriculum-level ones, so deeper, more specific data takes precedence.
   */
  #findSubjects(startDir) {
    const found = [];
    let current = startDir;
    for (let depth = 0; depth < 4; depth++) {
      const candidate = join(current, 'subjects.json');
      if (existsSync(candidate)) {
        const parsed = this.#readArray(candidate);
        if (parsed) found.push(...parsed);
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return found;
  }

  #hasCycle(start) {
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      for (const prereq of this.edges.get(id) || []) {
        if (this.edges.has(prereq) && visit(prereq)) return true;
      }
      seen.delete(id);
      return false;
    };
    return visit(start);
  }

  #readArray(path) {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(data) ? data : null;
    } catch (err) {
      this.loadErrors.push({ path, error: `invalid JSON: ${err.message}` });
      return null;
    }
  }

  #readObject(path) {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (err) {
      this.loadErrors.push({ path, error: `invalid JSON: ${err.message}` });
      return null;
    }
  }

  #put(map, key, value, label, schema) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      this.loadErrors.push({
        path: label,
        id: value?.id,
        error: `${label} schema invalid`,
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    map.set(key, parsed.data);
  }

  // ----------------------------------------------------------------- queries

  listCurricula() {
    return [...this.curricula.values()];
  }

  /** Throw-safe lookup that never returns another board's data. */
  getCurriculum(curriculumId) {
    return this.curricula.get(curriculumId) || null;
  }

  assertCurriculum(curriculumId) {
    const c = this.getCurriculum(curriculumId);
    if (!c) {
      const err = new Error(`Curriculum "${curriculumId}" is not available`);
      err.status = 404;
      err.code = 'CURRICULUM_NOT_FOUND';
      throw err;
    }
    return c;
  }

  assertGrade(curriculumId, grade) {
    const c = this.assertCurriculum(curriculumId);
    if (!c.supportedGrades.includes(Number(grade))) {
      const err = new Error(`Grade ${grade} is not available for curriculum ${curriculumId}`);
      err.status = 404;
      err.code = 'GRADE_NOT_AVAILABLE';
      err.supportedGrades = c.supportedGrades;
      throw err;
    }
  }

  listSubjects(curriculumId, grade) {
    this.assertGrade(curriculumId, grade);
    const subjects = [];
    for (const subject of this.subjects.values()) {
      if (subject.curriculumId === curriculumId && subject.grade === Number(grade)) {
        subjects.push(this.#withDerivedCoverage(subject, curriculumId, grade));
      }
    }
    return subjects.sort((a, b) => a.order - b.order);
  }

  getSubject(curriculumId, grade, subjectId) {
    return this.subjects.get(`${curriculumId}|${grade}|${subjectId}`) || null;
  }

  /** A subject is only usable if the pack actually has verified content. */
  #withDerivedCoverage(subject, curriculumId, grade) {
    const chapterIds = this.chaptersByScope.get(`${curriculumId}|${grade}|${subject.id}`) ?? [];
    const verifiedChapters = chapterIds.map((id) => this.chapters.get(id)).filter((c) => c && c.coverage !== 'retired');
    let coverage = subject.coverage;
    if (chapterIds.length === 0) {
      coverage = 'catalog_only';
    } else if (verifiedChapters.some((c) => c.coverage === 'assessment_ready' || c.coverage === 'reviewed')) {
      coverage = 'assessment_ready';
    } else if (verifiedChapters.every((c) => c.coverage === 'catalog_only')) {
      coverage = 'catalog_only';
    }
    return { ...subject, coverage };
  }

  listChapters(curriculumId, grade, subjectId) {
    this.assertGrade(curriculumId, grade);
    const subject = this.getSubject(curriculumId, grade, subjectId);
    if (!subject) {
      const err = new Error(`Subject "${subjectId}" is not available for grade ${grade} in ${curriculumId}`);
      err.status = 404;
      err.code = 'SUBJECT_NOT_AVAILABLE';
      throw err;
    }
    const chapterIds = this.chaptersByScope.get(`${curriculumId}|${grade}|${subjectId}`) ?? [];
    return chapterIds
      .map((id) => this.chapters.get(id))
      .filter(Boolean)
      .map((c) => ({ ...c, concepts: this.listConcepts(curriculumId, grade, subjectId, c.id) }))
      .sort((a, b) => a.order - b.order);
  }

  getChapter(curriculumId, chapterId) {
    const chapter = this.chapters.get(chapterId) || null;
    if (!chapter || chapter.curriculumId !== curriculumId) return null;
    return chapter;
  }

  listConcepts(curriculumId, grade, subjectId, chapterId) {
    const key = `${curriculumId}|${grade}|${subjectId}|${chapterId}`;
    const conceptIds = this.conceptsByChapter.get(key) ?? [];
    return conceptIds.map((id) => this.concepts.get(id)).filter(Boolean);
  }

  getConcept(curriculumId, conceptId) {
    const concept = this.concepts.get(conceptId) || null;
    if (!concept || concept.curriculumId !== curriculumId) return null;
    return concept;
  }

  /** Canonical prerequisite edges for a curriculum, as pairs. */
  conceptEdges(curriculumId) {
    const edges = [];
    for (const concept of this.concepts.values()) {
      if (concept.curriculumId !== curriculumId) continue;
      for (const prereq of concept.prerequisiteConceptIds || []) {
        edges.push({ from: prereq, to: concept.id });
      }
    }
    return edges;
  }

  /** Every concept in a curriculum. */
  allConcepts(curriculumId) {
    const out = [];
    for (const concept of this.concepts.values()) {
      if (concept.curriculumId === curriculumId) out.push(concept);
    }
    return out;
  }

  /**
   * Concepts ordered by the prerequisite graph, so the first concept is the one
   * with no prerequisites. Deterministic for a given pack.
   */
  conceptsInOrder(curriculumId) {
    const concepts = this.allConcepts(curriculumId);
    const ordered = [];
    const seen = new Set();
    const remaining = [...concepts];

    while (remaining.length) {
      const ready = remaining.filter(
        (c) => (c.prerequisiteConceptIds || []).every((p) => seen.has(p))
      );
      // If the graph has a cycle there is no fully-ready node; take the rest in
      // a stable order so a broken pack still loads instead of hanging.
      const batch = ready.length ? ready : remaining.slice(0, 1);
      batch.sort((a, b) => {
        if (a.recommendedDifficulty !== b.recommendedDifficulty) {
          return a.recommendedDifficulty - b.recommendedDifficulty;
        }
        return a.id.localeCompare(b.id);
      });
      const next = batch[0];
      ordered.push(next);
      seen.add(next.id);
      remaining.splice(remaining.indexOf(next), 1);
    }
    return ordered.map((c) => c.id);
  }

  getMisconceptionExplanation(curriculumId, code) {
    return this.misconceptions.get(`${curriculumId}|${code}`) || null;
  }

  getLessonAnchor(curriculumId, conceptId) {
    return this.lessonAnchors.get(`${curriculumId}|${conceptId}`) || null;
  }

  /** Verified, approved questions only. Never returns unverified items. */
  listQuestions(curriculumId, { grade, subjectId, chapterId, conceptId } = {}) {
    const out = [];
    for (const q of this.questions.values()) {
      if (q.curriculumId !== curriculumId) continue;
      if (q.verificationStatus !== 'verified' && q.verificationStatus !== 'reviewed') continue;
      if (grade !== undefined && q.grade !== Number(grade)) continue;
      if (subjectId !== undefined && q.subjectId !== subjectId) continue;
      if (chapterId !== undefined && q.chapterId !== chapterId) continue;
      if (conceptId !== undefined && q.conceptId !== conceptId) continue;
      out.push(q);
    }
    return out;
  }

  getQuestion(curriculumId, questionId) {
    const q = this.questions.get(questionId) || null;
    if (!q || q.curriculumId !== curriculumId) return null;
    return q;
  }

  /** Approved resources for a concept, deterministically ranked. */
  listResourcesForConcept(curriculumId, conceptId, { language } = {}) {
    const ids = this.resourcesByConcept.get(conceptId) ?? [];
    const items = ids
      .map((id) => this.resources.get(id))
      .filter((r) => r && r.curriculumId === curriculumId)
      .filter((r) => r.reviewStatus === 'verified' || r.reviewStatus === 'reviewed')
      .filter((r) => (language ? r.language === language : true));
    return items.sort((a, b) => {
      const rank = (r) => (r.reviewStatus === 'verified' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const typeRank = (r) => ['lesson', 'diagram', 'reading', 'worksheet', 'video', 'external_link'].indexOf(r.type);
      return typeRank(a) - typeRank(b);
    });
  }

  contentVersion(curriculumId) {
    return this.contentVersionByCurriculum.get(curriculumId) ?? null;
  }

  /** Coverage summary for reporting and health. */
  coverageReport() {
    const byCurriculum = new Map();
    for (const curriculum of this.curricula.values()) {
      byCurriculum.set(curriculum.id, {
        curriculumId: curriculum.id,
        board: curriculum.board,
        academicYear: curriculum.academicYear,
        grades: {},
      });
    }
    for (const subject of this.subjects.values()) {
      const row = byCurriculum.get(subject.curriculumId);
      if (!row) continue;
      const grade = subject.grade;
      row.grades[grade] = row.grades[grade] || { subjects: {}, subjectCount: 0 };
      const subjectRow = { id: subject.id, coverage: subject.coverage, chapters: [] };
      for (const chapter of this.chapters.values()) {
        if (
          chapter.curriculumId === subject.curriculumId &&
          chapter.grade === subject.grade &&
          chapter.subjectId === subject.id
        ) {
          const concepts = this.listConcepts(subject.curriculumId, subject.grade, subject.id, chapter.id);
          const questions = this.listQuestions(subject.curriculumId, { chapterId: chapter.id });
          subjectRow.chapters.push({
            id: chapter.id,
            title: chapter.title,
            coverage: chapter.coverage,
            concepts: concepts.length,
            questions: questions.length,
          });
        }
      }
      row.grades[grade].subjects[subject.id] = subjectRow;
    }
    return [...byCurriculum.values()];
  }
}

/** Singleton repository shared by the API and the CLI scripts. */
export const repository = new CurriculumRepository();

/** Load packs and return the shared instance. */
export function loadRepository() {
  return repository.load();
}

export { PACK_ROOT, CurriculumRepository };
