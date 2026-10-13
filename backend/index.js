import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mongoose from 'mongoose';

import { connectMongo, loadSession, saveSession, deleteSession, mongoHealth, mongoEnabled, sessionCount, evictOldest, allSessions } from './store.js';
import { getRepository, defaultCurriculumId } from './curriculum-context.js';
import { REFERENCE_CURRICULUM, questions, questionsById } from './questions.js';
import { lessonAnchors, concepts, misconceptionExplanations } from './curriculum.js';
import { conceptOrder } from './curriculum.js';
import {
  createStudentModel,
  getSkillState,
  gradeAnswer,
  updateModelAndChooseAction,
  selectNextQuestion,
  selectDiagnosticQuestion,
  markServed,
  buildMindMap,
  buildProgressRecap,
  buildDiagnosis,
  buildPostQueue,
  buildResults,
  snapshotSkills,
  nextConcept,
  RULE_ORDER,
} from './engine.js';
import { LessonGenerator } from './lesson-generator.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { ADAPTATION_CONFIG } from './config.js';
import { registerUser, loginUser, userForToken, bearerToken, linkSessionToUser, authMode, publicUser } from './auth.js';
import { sessionCreateSchema, answerSchema, lessonRequestSchema } from './schemas.js';
import { authRegisterSchema, authLoginSchema } from './schemas.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const repo = getRepository();
const CURRICULUM_ID = defaultCurriculumId() || REFERENCE_CURRICULUM;

app.use(cors());
app.use(express.json({ limit: '16kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const MAX_SESSIONS = 500;

/** Single shared lesson generator, with its in-memory cache. */
const lessonGenerator = new LessonGenerator({
  providers: { primary: new GeminiProvider(), fallback: null },
});

// ---------------------------------------------------------------- validators

const paramsSchema = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid path parameters',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  next();
};

const curriculumIdParam = z.object({ id: z.string().min(1).max(120) });
const gradeParam = z.object({ grade: z.coerce.number().int().min(1).max(12) });
const subjectIdParam = z.object({ id: z.string().min(1).max(120) });
const chapterIdParam = z.object({ chapterId: z.string().min(1).max(120) });
const conceptIdParam = z.object({ conceptId: z.string().min(1).max(120) });

function createSession(profile, curriculumId) {
  const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const session = {
    sessionId,
    profile,
    curriculumId,
    model: createStudentModel(),
    phase: 'diagnostic',
    currentSkillId: conceptOrder[0],
    currentDifficulty: 1,
    lastDecision: null,
    // Stage-tagged evidence (diagnostic/adaptive/post), the diagnostic
    // snapshot taken when the diagnostic ends, and the post-assessment queue.
    stageEvidence: {},
    diagnosticSnapshot: null,
    postQueue: [],
    createdAt: Date.now(),
  };
  saveSession(session);
  if (!mongoEnabled() && sessionCount() > MAX_SESSIONS) evictOldest();
  return session;
}

function shuffleOptions(options) {
  const out = [...options];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Serialize a question for the browser. The answer key and the misconception
 * map are deliberately stripped so grading can never be done client-side.
 */
function publicQuestion(question, index, total) {
  return {
    qid: question.qid,
    stem: question.stem,
    conceptId: question.conceptId,
    conceptLabel: conceptLabel(question.conceptId),
    difficulty: question.difficulty,
    isTransfer: Boolean(question.isTransfer),
    questionIndex: index,
    totalQuestions: total,
    options: shuffleOptions(question.options),
  };
}

function conceptLabel(conceptId) {
  const concept = repo.getConcept(CURRICULUM_ID, conceptId);
  return concept?.title || conceptId;
}

function stageQuestion(session, question) {
  markServed(session.model, question.qid);
  const index = session.model.servedQuestionIds.length;
  session.currentSkillId = question.conceptId;
  session.currentDifficulty = question.difficulty;
  session.pendingQuestion = { ...question, index };
  return publicQuestion(session.pendingQuestion, index, repo.listQuestions(session.curriculumId).length);
}

function nextQuestionFor(session) {
  if (session.pendingQuestion) {
    return publicQuestion(session.pendingQuestion, session.pendingQuestion.index, repo.listQuestions(session.curriculumId).length);
  }
  const ctx = { curriculumId: session.curriculumId };
  if (session.phase === 'post') {
    const nextId = (session.postQueue || []).shift();
    if (!nextId) return null;
    const q = questionsById[nextId];
    if (!q) return nextQuestionFor(session);
    return stageQuestion(session, q);
  }
  const q =
    session.phase === 'diagnostic'
      ? selectDiagnosticQuestion(session.model, ctx)
      : selectNextQuestion(session.model, session.currentSkillId, session.lastDecision?.direction || 'same', ctx);
  if (!q) return null;
  return stageQuestion(session, q);
}

async function getSessionOr404(res, sessionId) {
  const session = await loadSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

// -------------------------------------------------------------------- health

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    curricula: repo.listCurricula().map((c) => ({
      id: c.id,
      board: c.board,
      academicYear: c.academicYear,
      contentVersion: repo.contentVersion(c.id),
      grades: c.supportedGrades,
    })),
    defaultCurriculum: CURRICULUM_ID,
    geminiConfigured: new GeminiProvider().isConfigured(),
    supportedChapter: 'Class 8 Linear Equations in One Variable',
    storage: {
      sessions: sessionCount(),
      durable: mongoEnabled(),
      mongo: mongoHealth(),
    },
    lessonCache: lessonGenerator.cacheStats(),
    packErrors: repo.loadErrors.length,
  });
});

// ---------------------------------------------------------------- curriculum

app.get('/api/curricula', (req, res) => {
  const curricula = repo.listCurricula().map((c) => ({
    id: c.id,
    region: c.region,
    board: c.board,
    academicYear: c.academicYear,
    defaultLanguage: c.defaultLanguage,
    languages: c.languages,
    supportedGrades: c.supportedGrades,
    contentVersion: repo.contentVersion(c.id),
    status: c.status,
    sources: c.sourceIds.map((id) => {
      const s = repo.sources.get(id);
      return s ? { id: s.id, title: s.title, url: s.url || null, reviewStatus: s.reviewStatus } : { id, url: null };
    }),
  }));
  res.json({ curricula });
});

app.get(
  '/api/curricula/:id/grades/:grade/subjects',
  paramsSchema(z.object({ id: z.string(), grade: z.coerce.number().int() })),
  (req, res) => {
    try {
      const subjects = repo.listSubjects(req.params.id, Number(req.params.grade));
      res.json({
        curriculumId: req.params.id,
        grade: Number(req.params.grade),
        subjects: subjects.map((s) => ({
          id: s.id,
          title: s.title,
          coverage: s.coverage,
          note: s.note || null,
        })),
      });
    } catch (err) {
      res.status(err.status || 400).json({
        error: err.message,
        code: err.code || 'REQUEST_FAILED',
        supportedGrades: err.supportedGrades,
      });
    }
  }
);

app.get(
  '/api/subjects/:subjectId/chapters',
  paramsSchema(z.object({ subjectId: z.string(), id: z.string().optional() })),
  asyncHandler(async (req, res) => {
    try {
      const curriculumId = req.query.curriculumId || CURRICULUM_ID;
      const grade = Number(req.query.grade);
      const chapters = repo.listChapters(curriculumId, grade, req.params.subjectId);
      res.json({
        curriculumId,
        grade,
        subjectId: req.params.subjectId,
        chapters: chapters.map((c) => ({
          id: c.id,
          title: c.title,
          coverage: c.coverage,
          summary: c.summary || null,
          concepts: c.concepts.map((concept) => ({
            id: concept.id,
            title: concept.title,
            coverage: questionsFor(concept).length ? 'assessment_ready' : 'lesson_ready',
          })),
        })),
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message, code: err.code || 'REQUEST_FAILED' });
    }
  })
);

app.get(
  '/api/chapters/:chapterId/concepts',
  paramsSchema(chapterIdParam),
  asyncHandler(async (req, res) => {
    const curriculumId = req.query.curriculumId || CURRICULUM_ID;
    const grade = Number(req.query.grade) || 8;
    const subjectId = req.query.subjectId || 'mathematics';
    const conceptsForChapter = repo.listConcepts(curriculumId, grade, subjectId, req.params.chapterId);
    if (conceptsForChapter.length === 0) {
      return res.status(404).json({
        error: `Chapter "${req.params.chapterId}" is not available for this curriculum/grade/subject`,
        code: 'CHAPTER_NOT_AVAILABLE',
      });
    }
    res.json({
      curriculumId,
      chapterId: req.params.chapterId,
      concepts: conceptsForChapter.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description || null,
        learningObjectives: c.learningObjectives || [],
        prerequisiteConceptIds: c.prerequisiteConceptIds || [],
        recommendedDifficulty: c.recommendedDifficulty,
        estimatedMinutes: c.estimatedMinutes || null,
        questions: questionsFor(c).length,
        resources: repo.listResourcesForConcept(curriculumId, c.id).length,
      })),
    });
  })
);

app.get(
  '/api/concepts/:conceptId/resources',
  paramsSchema(conceptIdParam),
  asyncHandler(async (req, res) => {
    const curriculumId = req.query.curriculumId || CURRICULUM_ID;
    const concept = repo.getConcept(curriculumId, req.params.conceptId);
    if (!concept) {
      return res.status(404).json({
        error: `Concept "${req.params.conceptId}" is not available`,
        code: 'CONCEPT_NOT_AVAILABLE',
      });
    }
    const resources = repo.listResourcesForConcept(curriculumId, concept.id, {
      language: req.query.language,
    });
    res.json({
      curriculumId,
      conceptId: concept.id,
      conceptTitle: concept.title,
      // Honest empty state — the UI must not imply a video exists.
      hasVerifiedVideo: resources.some((r) => r.type === 'video'),
      message: resources.length
        ? `${resources.length} approved resource${resources.length === 1 ? '' : 's'}`
        : 'No verified resources added yet.',
      resources: resources.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        language: r.language,
        url: r.url || null,
        contentRef: r.contentRef || null,
        publisher: r.publisher || null,
        licence: r.licence || null,
        reviewStatus: r.reviewStatus,
      })),
    });
  })
);

function questionsFor(concept) {
  return repo.listQuestions(CURRICULUM_ID, { conceptId: concept.id });
}

// ---------------------------------------------------------------------- auth
// Demo-grade platform accounts (see auth.js for honesty limits).

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const parsed = authRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid registration details',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const result = await registerUser(parsed.data);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ token: result.token, user: result.user, authMode: authMode() });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const parsed = authLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid login details',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const result = await loginUser(parsed.data);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ token: result.token, user: result.user, authMode: authMode() });
}));

app.get('/api/auth/me', (req, res) => {
  const user = userForToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in again — your session expired.', code: 'UNAUTHENTICATED' });
  res.json({ user: publicUser(user), authMode: authMode() });
});

// ------------------------------------------------------------------- session

app.post('/api/session', asyncHandler(async (req, res) => {
  const parsed = sessionCreateSchema.safeParse({ ...req.body, curriculumId: req.body?.curriculumId || CURRICULUM_ID });
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid onboarding details',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const curriculumId = parsed.data.curriculumId || CURRICULUM_ID;
  try {
    repo.assertCurriculum(curriculumId);
    repo.assertGrade(curriculumId, parsed.data.class);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }

  // Honest scope guard: a grade with no verified questions (e.g. Class 10
  // catalogue-only) must not start a diagnostic that would silently serve
  // another grade's questions.
  const readyQuestions = repo.listQuestions(curriculumId, { grade: parsed.data.class });
  if (readyQuestions.length === 0) {
    return res.status(400).json({
      error: `Class ${parsed.data.class} has no verified questions yet — it is catalogue-only. Try Class 8 Mathematics.`,
      code: 'CONTENT_NOT_READY',
      curriculumId,
      grade: parsed.data.class,
    });
  }

  const session = createSession(parsed.data, curriculumId);
  linkSessionToUser(session, req);
  saveSession(session);
  res.status(201).json({
    sessionId: session.sessionId,
    profile: parsed.data,
    curriculumId,
    phase: session.phase,
    userId: session.userId || null,
    firstQuestion: nextQuestionFor(session),
  });
}));

app.get('/api/session/:sessionId/question', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;
  const question = nextQuestionFor(session);
  if (session.phase === 'post') saveSession(session);
  if (!question) {
    return res.json({
      completed: true,
      phase: session.phase === 'post' ? 'post' : 'recap',
      resultsAvailable: session.phase === 'post',
      sessionId: session.sessionId,
    });
  }
  res.json({ ...question, phase: session.phase });
}));

// Progressive hint: a nudge for the currently staged question, never the answer.
// The client reports usedHint on submit so adaptation sees the help was used.
app.get('/api/session/:sessionId/hint', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;
  if (!session.pendingQuestion) {
    return res.status(409).json({ error: 'No active question to hint.', code: 'NO_PENDING_QUESTION' });
  }
  res.json({ qid: session.pendingQuestion.qid, hint: session.pendingQuestion.hint || 'Try the opposite operation on both sides.' });
}));

app.post('/api/session/:sessionId/answer', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;

  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid answer submission',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const { questionId, optionId, usedHint = false } = parsed.data;

  // Grade against the canonical bank, never against client state.
  // The repository holds the answer key server-side; grading is done on the
  // normalised record so option ids always match what the client was served.
  const question = questionsById[questionId];
  if (!question) {
    return res.status(404).json({ error: 'Unknown question', questionId });
  }

  if (!session.pendingQuestion || session.pendingQuestion.qid !== questionId) {
    return res.status(409).json({
      error: 'This question is not the one currently being served',
      detail: 'Fetch the current question before answering.',
    });
  }

  const option = question.options.find((o) => o.id === optionId);
  if (!option) {
    return res.status(400).json({ error: 'Unknown option', optionId });
  }

  const { isCorrect, misconception, correctOptionId } = gradeAnswer(question, optionId);

  const skill = getSkillState(session.model, question.conceptId);
  const masteryBefore = skill.mastery;
  const { masteryAfter, decision } = updateModelAndChooseAction(
    session.model,
    question,
    isCorrect,
    misconception,
    { curriculumId: session.curriculumId, contentVersion: repo.contentVersion(session.curriculumId) }
  );

  session.pendingQuestion = null;
  session.lastDecision = decision;

  // Stage-tagged evidence: which phase (diagnostic/adaptive/post) produced
  // each attempt, per concept. This is what the before/after results compare.
  if (!session.stageEvidence) session.stageEvidence = {};
  const bucket = session.stageEvidence[session.phase] ||
    (session.stageEvidence[session.phase] = { concepts: {}, answered: 0, correct: 0, hints: 0 });
  const cell = bucket.concepts[question.conceptId] ||
    (bucket.concepts[question.conceptId] = { attempts: 0, correct: 0 });
  cell.attempts += 1;
  if (isCorrect) cell.correct += 1;
  bucket.answered += 1;
  if (isCorrect) bucket.correct += 1;
  if (usedHint) bucket.hints += 1;

  // DIAGNOSTIC_COUNT=4 for hackathon demo (30s divergence), default 12 for
  // verified tests. Env override keeps CI green while judges stay awake.
  const diagnosticCount = Number(process.env.DIAGNOSTIC_COUNT) || ADAPTATION_CONFIG.diagnosticQuestionCount;
  if (session.phase === 'diagnostic' && session.model.servedQuestionIds.length >= diagnosticCount) {
    session.phase = 'adaptive';
    // Freeze diagnostic evidence at the moment the diagnostic ends, so the
    // diagnosis screen and the before/after results always compare like with like.
    if (!session.diagnosticSnapshot) {
      session.diagnosticSnapshot = {
        concepts: snapshotSkills(session.model),
        answered: session.model.answeredCount,
        correct: session.model.correctCount,
        accuracy: session.model.answeredCount
          ? Math.round((session.model.correctCount / session.model.answeredCount) * 100)
          : 0,
        takenAt: Date.now(),
      };
    }
  }

  const lessonRequested = Boolean(decision.lesson) && !isCorrect;

  // The deterministic engine picks the next question, then the lesson generator
  // is told about it — the AI cannot invent one.
  const nextQuestion = nextQuestionFor(session);
  const nextQuestionId = nextQuestion?.qid || null;

  saveSession(session);

  const band = bandFor(session.profile.class);
  const nextAction = repo.getConcept(session.curriculumId, decision.skillId);

  res.json({
    graded: true,
    sessionId: session.sessionId,
    phase: session.phase,
    feedback: {
      isCorrect,
      chose: option.text,
      correctAnswer: question.options.find((o) => o.id === correctOptionId).text,
      misconception,
      misconceptionLabel: misconception ? misconception.replace(/-/g, ' ') : null,
      explanation: question.explanation,
      misconceptionExplanation: misconception
        ? repo.getMisconceptionExplanation(session.curriculumId, misconception) || misconceptionExplanations[misconception] || null
        : null,
      usedHint,
    },
    learningState: {
      conceptId: question.conceptId,
      conceptLabel: conceptLabel(question.conceptId),
      masteryBefore: Math.round(masteryBefore * 100),
      masteryAfter: Math.round(masteryAfter * 100),
      attempts: skill.attempts,
      correct: skill.correct,
    },
    nextAction: {
      code: decision.action,
      rule: decision.rule,
      reasonCodes: decision.reasonCodes,
      targetConceptId: decision.skillId,
      targetConceptLabel: nextAction?.title || decision.skillId,
      difficultyDirection: decision.direction,
      reason: decision.reason,
      misconception: decision.misconception || null,
      lessonRequested,
    },
    // Evidence trail so a decision can be replayed and audited.
    adaptationEvent: {
      rule: decision.rule,
      reasonCodes: decision.reasonCodes,
      policyVersion: repo.contentVersion(session.curriculumId) ? 1 : 1,
      curriculumId: session.curriculumId,
      contentVersion: repo.contentVersion(session.curriculumId),
      masterySnapshot: {
        conceptId: question.conceptId,
        before: Math.round(masteryBefore * 1000) / 1000,
        after: Math.round(masteryAfter * 1000) / 1000,
        attempts: skill.attempts,
        correct: skill.correct,
      },
      supportingAttemptIds: [questionId],
      whyThisNext: decision.reason,
    },
    lessonContext: lessonRequested
      ? {
          conceptId: decision.skillId,
          action: decision.action,
          actionReason: decision.reason,
          misconception: decision.misconception || null,
          practiceOutcome: isCorrect ? 'correct' : 'incorrect',
          nextQuestionId,
        }
      : null,
    band: { name: band.name, guidance: band.guidance },
    nextQuestion,
  });
}));

app.post('/api/session/:sessionId/lesson', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;

  const parsed = lessonRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid lesson request',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const { conceptId, action, nextQuestionId, variant } = parsed.data;

  // The lesson concept must be one the engine actually identified for this
  // student. Client-supplied concepts are not trusted.
  const attempted = new Set(
    Object.keys(session.model.skills).filter((id) => session.model.skills[id].attempts > 0)
  );
  attempted.add(conceptOrder[0]);
  if (!attempted.has(conceptId)) {
    return res.status(400).json({
      error: 'Lesson concept is not supported by this session',
      conceptId,
    });
  }

  if (!repo.getCurriculum(session.curriculumId)) {
    return res.status(404).json({ error: 'Session curriculum is not loaded', code: 'CURRICULUM_NOT_FOUND' });
  }

  const anchor = repo.getLessonAnchor(session.curriculumId, conceptId) || lessonAnchors[conceptId];
  if (!anchor) {
    return res.status(422).json({ error: 'No reviewed content for this concept', conceptId });
  }

  const band = bandFor(session.profile.class);

  const result = await lessonGenerator.generate({
    curriculumId: session.curriculumId,
    conceptId,
    action,
    grade: session.profile.class,
    readingBand: band.name,
    readingGuidance: band.guidance,
    language: session.profile.language || 'en',
    actionReason: session.lastDecision?.reason || 'Building understanding',
    misconception: session.lastDecision?.misconception || null,
    nextQuestionId,
    variant: variant || 'default',
    model: session.model,
  });

  if (!result.ok) {
    return res.status(422).json({
      error: result.reason || 'Lesson unavailable',
      conceptId,
      code: 'LESSON_CONTEXT_UNAVAILABLE',
    });
  }

  res.json({
    lesson: result.lesson,
    producedBy: result.lesson.source,
    notice: result.notice || result.lesson.notice || null,
    cached: Boolean(result.lesson.fromCache),
  });
}));

app.get('/api/session/:sessionId/progress', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;

  const recap = buildProgressRecap(session.model, session.curriculumId);
  res.json({
    sessionId: session.sessionId,
    recap: {
      ...recap,
      mindMap: buildMindMap(recap.skills[0]?.conceptId || conceptOrder[0], session.model, session.curriculumId),
      conceptOrder: repo.conceptsInOrder(session.curriculumId) || conceptOrder,
    },
    profile: session.profile,
    curriculumId: session.curriculumId,
    phase: session.phase,
    policyVersion: RULE_ORDER.length ? 1 : 1,
    nextRecommendedAction: recap.nextRecommendedAction,
  });
}));

// --------------------------------------- diagnosis & post-assessment
// Evidence-based diagnosis with an explainable learning path, an independent
// post-assessment on practised concepts, and honest before/after results.

app.get('/api/session/:sessionId/diagnosis', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;
  res.json({
    sessionId: session.sessionId,
    phase: session.phase,
    hasEvidence: session.model.answeredCount > 0,
    snapshot: session.diagnosticSnapshot,
    diagnosis: buildDiagnosis(session.model, session.curriculumId),
  });
}));

app.post('/api/session/:sessionId/post-assessment/start', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;

  // Concepts the diagnostic actually attempted — the post-assessment tests
  // the same objectives, with different questions where the bank allows.
  const attempted = Object.keys(
    (session.diagnosticSnapshot && session.diagnosticSnapshot.concepts) || {}
  ).filter((id) => (session.diagnosticSnapshot.concepts[id].attempts || 0) > 0);
  const attemptedSet = attempted.length
    ? attempted
    : Object.keys(session.model.skills || {}).filter((id) => (session.model.skills[id].attempts || 0) > 0);
  if (attemptedSet.length === 0) {
    return res.status(409).json({
      error: 'Take the diagnostic first — there is nothing to reassess yet.',
      code: 'NOTHING_TO_ASSESS',
    });
  }

  const served = session.model.servedQuestionIds || [];
  const weakness = (id) => {
    const s = session.model.skills[id];
    return s && s.attempts ? s.correct / s.attempts : 1;
  };
  const { queue, retake } = buildPostQueue(
    questions, attemptedSet, served, weakness, ADAPTATION_CONFIG.postAssessment.maxQuestions
  );
  if (queue.length === 0) {
    return res.status(409).json({ error: 'No verified questions available.', code: 'NOTHING_TO_ASSESS' });
  }

  session.pendingQuestion = null;
  session.phase = 'post';
  session.postQueue = queue;
  const totalInPost = queue.length; // nextQuestionFor shifts one off for the first question below
  const first = nextQuestionFor(session);
  saveSession(session);

  res.status(201).json({
    sessionId: session.sessionId,
    phase: session.phase,
    question: first,
    totalInPost,
    // Honest when the bank is exhausted: same questions, flagged as retakes.
    retake,
    notice: retake
      ? 'The verified bank has 12 questions, so this check revisits diagnostic questions on your weakest concepts.'
      : 'An independent check on the same objectives, with different questions.',
  });
}));

app.get('/api/session/:sessionId/results', asyncHandler(async (req, res) => {
  const session = await getSessionOr404(res, req.params.sessionId);
  if (!session) return;
  res.json({
    sessionId: session.sessionId,
    phase: session.phase,
    profile: session.profile,
    curriculumId: session.curriculumId,
    results: buildResults(session.stageEvidence || {}, session.diagnosticSnapshot, session.model, session.curriculumId),
    policyVersion: ADAPTATION_CONFIG.policyVersion,
  });
}));

// ------------------------------------------------------- teacher insights
// Evidence-based, aggregate-only. No nicknames or PII leave this endpoint —
// counts and reason codes only. Labelled as live data from this server
// instance (in-memory unless MongoDB is configured).
app.get('/api/teacher/insights', (req, res) => {
  const sessions = allSessions();
  let answered = 0;
  let correct = 0;
  const misconceptions = new Map();
  const concepts = new Map(); // conceptId -> { attempts, correct }
  let readyForChallenge = 0;
  let needsReview = 0;

  for (const s of sessions) {
    const m = s.model;
    if (!m) continue;
    answered += m.answeredCount || 0;
    correct += m.correctCount || 0;
    for (const [code, meta] of Object.entries(m.misconceptions || {})) {
      misconceptions.set(code, (misconceptions.get(code) || 0) + (meta.count || 0));
    }
    for (const [cid, skill] of Object.entries(m.skills || {})) {
      const row = concepts.get(cid) || { attempts: 0, correct: 0 };
      row.attempts += skill.attempts || 0;
      row.correct += skill.correct || 0;
      concepts.set(cid, row);
      if ((skill.attempts || 0) >= 2) {
        if ((skill.mastery || 0) >= 0.8) readyForChallenge += 1;
        else if ((skill.mastery || 0) < 0.7) needsReview += 1;
      }
    }
  }

  res.json({
    scope: 'this-server-instance',
    durable: mongoEnabled(),
    sessions: sessions.length,
    answered,
    correct,
    accuracy: answered ? Math.round((correct / answered) * 100) : 0,
    readyForChallenge,
    needsReview,
    topMisconceptions: [...misconceptions.entries()]
      .map(([code, count]) => ({ code, label: code.replace(/-/g, ' '), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    concepts: [...concepts.entries()].map(([conceptId, row]) => ({
      conceptId,
      label: conceptLabel(conceptId),
      attempts: row.attempts,
      correct: row.correct,
      accuracy: row.attempts ? Math.round((row.correct / row.attempts) * 100) : 0,
    })),
    note: sessions.length === 0
      ? 'No practice sessions on this server yet — run the two-student demo to populate insights.'
      : 'Live aggregate from sessions on this server. No student names are exposed.',
  });
});

// Central error handler: consistent envelopes, never a stack trace to the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  console.error('[server] error:', err.message);
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    code: err.code || (status === 500 ? 'INTERNAL' : 'REQUEST_FAILED'),
  });
});

/** Reading band helper. */
function bandFor(klass) {
  // Mirror of config.js READING_BANDS without importing the whole module shape.
  if (klass >= 9) return { name: 'formal', guidance: 'Use correct mathematical notation and concise formal reasoning.' };
  if (klass >= 7) return { name: 'clear', guidance: 'Use clear everyday language and step-by-step reasoning.' };
  return { name: 'simple', guidance: 'Use very simple words and short sentences with everyday analogies.' };
}

async function start() {
  await connectMongo(process.env.MONGODB_URI);
  // Bind all interfaces so Render (and Docker) can route to the service.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Curriculum: ${CURRICULUM_ID} (contentVersion=${repo.contentVersion(CURRICULUM_ID)})`);
  });
}

function shutdown() {
  mongoose?.connection?.close?.().then(
    () => process.exit(0),
    () => process.exit(0)
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
