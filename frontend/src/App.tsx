import React, { useState, useEffect } from 'react';
import { api, getToken, getStoredUser, storeAuth, clearAuth } from '@/api';
import type {
  OnboardingData,
  Profile,
  Question,
  AnswerFeedback,
  NextAction,
  LessonContext,
  ProgressRecap,
  Curriculum,
  SubjectEntry,
  ChapterEntry,
  ConceptEntry,
  TeacherInsights,
  AuthUser,
  Diagnosis,
  Results,
} from '@/api';
import { LessonScreen } from '@/lesson';
import { MindMapDiagram } from '@/mindmap';

/**
 * One continuous learning journey:
 * onboarding -> diagnostic -> (lesson when a misconception appears) ->
 * practice -> progress recap.
 *
 * The server owns grading, mastery and every next-step decision. This component
 * only renders what it is told and sends answers back.
 */

const STORAGE_KEY = 'ahapath-session-v2';

// DEMO-ONLY answer key for hackathon auto-play (?demo=weak / ?demo=strong).
// Grading stays server-side; this is only so judges can see divergence in 30s
// without knowing the answers. Do not use for real assessment.
const DEMO_CORRECT: Record<string, string> = {
  'le-01': 'opt-7', 'le-02': 'opt-11', 'le-03': 'opt-7', 'le-04': 'opt-12',
  'le-05': 'opt-4', 'le-06': 'opt-5', 'le-07': 'opt-4', 'le-08': 'opt-5',
  'le-09': 'opt-5', 'le-10': 'opt-3', 'le-11': 'opt-4', 'le-12': 'opt-4',
};

const ACTION_BLURB: Record<string, string> = {
  'targeted-review': 'Targeted review',
  'guided-practice': 'Guided practice',
  'misconception-repair': 'Fixing a misconception',
  'harder-challenge': 'Harder challenge',
  'continue': 'Practise',
};

const PATH_KIND_LABEL: Record<string, string> = {
  lesson: 'Lesson',
  practice: 'Practice',
  assessment: 'Check',
  advance: 'Next',
};

type Screen = 'landing' | 'login' | 'register' | 'dashboard' | 'onboarding' | 'quiz' | 'lesson' | 'diagnosis' | 'progress' | 'results' | 'teacher';

export function CoverageBadge({ coverage }: { coverage: string }) {
  const map: Record<string, string> = {
    assessment_ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    lesson_ready: 'bg-sky-50 text-sky-700 border-sky-200',
    reviewed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    catalog_only: 'bg-gray-100 text-gray-600 border-gray-200',
    limited_preview: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  const label = coverage.replace(/_/g, ' ');
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${map[coverage] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
      {label}
    </span>
  );
}

interface StoredSession {
  sessionId: string;
  profile: Profile;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [profile, setProfile] = useState<OnboardingData>({
    nickname: '',
    class: 8,
    subject: 'mathematics',
    chapter: 'Linear Equations',
    language: 'en',
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [phase, setPhase] = useState<string>('diagnostic');
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingQuestion, setLoadingQuestion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Last graded answer, shown before moving on.
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [mastery, setMastery] = useState<{ before: number; after: number } | null>(null);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [lessonContext, setLessonContext] = useState<LessonContext | null>(null);
  const [pendingNext, setPendingNext] = useState<Question | null>(null);

  // Lesson screen inputs.
  const [lessonRequest, setLessonRequest] = useState<LessonContext | null>(null);

  const [recap, setRecap] = useState<ProgressRecap | null>(null);
  const [serverBanner, setServerBanner] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState<string | null>(null);

  // Diagnosis (after the diagnostic) and before/after results (after post-assessment).
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [postNotice, setPostNotice] = useState<string | null>(null);

  // Curriculum journey (real API data, never hardcoded marketing).
  const [curricula, setCurricula] = useState<Curriculum[]>([]);
  const [curriculumId, setCurriculumId] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<SubjectEntry[]>([]);
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [concepts, setConcepts] = useState<ConceptEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [insights, setInsights] = useState<TeacherInsights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean>(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  // Platform auth form state.
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authGrade, setAuthGrade] = useState(8);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // ------------------------------------------------------------------- boot
  useEffect(() => {
    let demo = false;
    try {
      const params = new URLSearchParams(window.location.search);
      const d = params.get('demo');
      if (d === 'weak' || d === 'strong') {
        demo = true;
        setDemoMode(d);
        setProfile((p) => ({ ...p, nickname: d === 'weak' ? 'Aarav (demo)' : 'Meera (demo)' }));
      }
    } catch {
      // ignore — demo flag is optional
    }
    api
      .health()
      .then((h) => setServerBanner(h.geminiConfigured ? null : 'AI lessons are in fallback mode on this server.'))
      .catch(() => setError('Cannot reach the server. Is the backend running?'));

    (async () => {
      try {
        if (demo) {
          setScreen('onboarding');
          return;
        }
        if (getToken()) {
          try {
            const { user, authMode } = await api.me();
            setAuthUser(user);
            setAuthMode(authMode);
            setProfile((p) => ({
              ...p,
              nickname: p.nickname || user.name,
              class: p.nickname ? p.class : user.grade,
            }));
            setScreen('dashboard');
            return;
          } catch {
            clearAuth();
          }
        }
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          const saved = raw ? (JSON.parse(raw) as StoredSession | null) : null;
          if (saved?.sessionId) {
            setSessionId(saved.sessionId);
            setProfile(saved.profile);
            setScreen('quiz');
            return;
          }
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
        const stored = getStoredUser();
        if (stored && getToken()) {
          setAuthUser(stored);
          setScreen('dashboard');
          return;
        }
        setScreen('landing');
      } finally {
        setAuthChecking(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (sessionId) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, profile }));
      } catch {
        // Storage full or unavailable; the demo still works in-memory.
      }
    }
  }, [sessionId, profile]);

  // Load a question whenever the quiz screen has none.
  useEffect(() => {
    if (screen === 'quiz' && sessionId && !question && !feedback && !loadingQuestion) {
      loadQuestion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, sessionId]);

  // Curriculum catalogue: curricula once, then dependent subjects/chapters/concepts.
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  useEffect(() => {
    if (screen !== 'onboarding') return;
    let cancelled = false;
    (async () => {
      try {
        const { curricula } = await api.listCurricula();
        if (cancelled) return;
        setCurricula(curricula);
        const firstCurriculum = curricula[0];
        if (curricula.length > 0 && !curriculumId && firstCurriculum) {
          setCurriculumId(firstCurriculum.id);
        }
      } catch (e: any) {
        if (!cancelled) setCatalogError(e.message || 'Could not load curricula.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (screen !== 'onboarding' || !curriculumId) return;
    let cancelled = false;
    (async () => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const res = await api.listSubjects(curriculumId, profile.class);
        if (cancelled) return;
        setSubjects(res.subjects);
        // Keep selection valid when grade changes.
        if (!res.subjects.some((s) => s.id === profile.subject)) {
          const firstReady = res.subjects.find((s) => s.coverage !== 'catalog_only') || res.subjects[0];
          if (firstReady) setProfile((p) => ({ ...p, subject: firstReady.id }));
        }
      } catch (e: any) {
        if (!cancelled) {
          setSubjects([]);
          setCatalogError(e.message || 'This grade is not covered by the pack.');
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, curriculumId, profile.class]);

  useEffect(() => {
    if (screen !== 'onboarding' || !curriculumId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listChapters(curriculumId, profile.class, profile.subject);
        if (cancelled) return;
        setChapters(res.chapters);
        if (res.chapters.length > 0) {
          const first = res.chapters[0];
          if (first) {
            setSelectedChapterId(first.id);
            setProfile((p) => ({ ...p, chapter: first.title }));
          }
        } else {
          setSelectedChapterId(null);
        }
      } catch {
        if (!cancelled) {
          setChapters([]);
          setSelectedChapterId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, curriculumId, profile.class, profile.subject]);

  useEffect(() => {
    if (screen !== 'onboarding' || !curriculumId || !selectedChapterId) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listConcepts(curriculumId, profile.class, profile.subject, selectedChapterId);
        if (!cancelled) setConcepts(res.concepts);
      } catch {
        if (!cancelled) setConcepts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, curriculumId, profile.class, profile.subject, selectedChapterId]);

  // ---------------------------------------------------------------- actions
  async function loadQuestion() {
    if (!sessionId) return;
    setLoadingQuestion(true);
    setError(null);
    try {
      const q = await api.getQuestion(sessionId);
      if ('completed' in q && q.completed) {
        if ((q as { phase?: string }).phase === 'post') {
          await openResults();
        } else {
          await openProgress();
        }
      } else {
        setQuestion(q as Question);
      }
    } catch (e: any) {
      if (e.message?.includes('Session not found')) {
        reset();
        setError('Your session expired. Please start again.');
        return;
      }
      setError(e.message || 'Could not load the question.');
    } finally {
      setLoadingQuestion(false);
    }
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!profile.nickname.trim()) return;
    if (!isStartReady) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.createSession({ ...profile, curriculumId: curriculumId || undefined });
      setSessionId(res.sessionId);
      setProfile(res.profile);
      setQuestion(res.firstQuestion);
      setPhase(res.phase);
      setScreen('quiz');
    } catch (e: any) {
      setError(e.message || 'Could not start the session.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(optionOverride?: string) {
    const optionId = optionOverride || selected;
    if (!sessionId || !question || !optionId) return;
    const wasDiagnostic = phase === 'diagnostic';
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.submitAnswer(sessionId, question.qid, optionId, !!hint);
      setSelected(optionId);
      setFeedback(res.feedback);
      setMastery({ before: res.learningState.masteryBefore, after: res.learningState.masteryAfter });
      setNextAction(res.nextAction);
      setLessonContext(res.lessonContext);
      setPendingNext(res.nextQuestion);
      setPhase(res.phase);
      // The diagnostic just ended: show the evidence-based diagnosis and the
      // personal learning path before continuing into adaptive practice.
      if (wasDiagnostic && res.phase === 'adaptive') {
        try {
          const d = await api.getDiagnosis(sessionId);
          setDiagnosis(d.diagnosis);
          setScreen('diagnosis');
        } catch {
          // Diagnosis is explanatory; never strand the student if it fails.
        }
      }
    } catch (e: any) {
      if (e.message?.includes('Session not found')) {
        reset();
        setError('Your session expired. Please start again.');
        return;
      }
      setError(e.message || 'Could not submit your answer.');
    } finally {
      setSubmitting(false);
    }
  }

  /** Progressive nudge: fetches the question hint, never the answer. */
  async function handleHint() {
    if (!sessionId || hint || hintLoading) return;
    setHintLoading(true);
    try {
      const res = await api.getHint(sessionId);
      setHint(res.hint);
    } catch (e: any) {
      setError(e.message || 'Could not load the hint.');
    } finally {
      setHintLoading(false);
    }
  }
  /** Hackathon shortcut: answer correctly or deliberately wrong for the demo. */
  function handleDemoAnswer(wantCorrect: boolean) {
    if (!question) return;
    const correctId = DEMO_CORRECT[question.qid];
    let pick: string | undefined;
    if (wantCorrect) {
      pick = correctId && question.options.some((o) => o.id === correctId)
        ? correctId
        : question.options[0]?.id;
    } else {
      pick = question.options.find((o) => o.id !== correctId)?.id || question.options[0]?.id;
    }
    if (pick) void handleSubmit(pick);
  }

  /** After feedback: either the lesson or the next practice question. */
  function handleContinue() {
    if (nextAction?.lessonRequested && lessonContext) {
      setLessonRequest(lessonContext);
      setScreen('lesson');
      return;
    }
    if (pendingNext) {
      setQuestion(pendingNext);
      setPendingNext(null);
      clearAnswerState();
      return;
    }
    // The post-assessment just ended: show before/after results, not the recap.
    if (phase === 'post') {
      void openResults();
      return;
    }
    openProgress();
  }

  function clearAnswerState() {
    setFeedback(null);
    setHint(null);
    setMastery(null);
    setNextAction(null);
    setLessonContext(null);
    setSelected(null);
  }

  /** Leaving the lesson: open the practice question the engine selected. */
  async function finishLesson() {
    setLessonRequest(null);
    if (pendingNext) {
      setQuestion(pendingNext);
      setPendingNext(null);
      clearAnswerState();
      setScreen('quiz');
    } else {
      await openProgress();
    }
  }

  async function openProgress() {
    if (!sessionId) return;
    setError(null);
    try {
      const res = await api.getProgress(sessionId);
      setRecap(res.recap);
      setScreen('progress');
    } catch (e: any) {
      setError(e.message || 'Could not load your progress.');
    }
  }

  async function openResults() {
    if (!sessionId) return;
    setError(null);
    try {
      const res = await api.getResults(sessionId);
      setResults(res.results);
      setScreen('results');
    } catch (e: any) {
      setError(e.message || 'Could not load your results.');
    }
  }

  async function startPostAssessment() {
    if (!sessionId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.startPostAssessment(sessionId);
      setQuestion(res.question);
      setPhase(res.phase);
      setPostNotice(res.notice);
      clearAnswerState();
      setScreen('quiz');
    } catch (e: any) {
      setError(e.message || 'Could not start the post-assessment.');
    } finally {
      setSubmitting(false);
    }
  }

  async function openTeacher() {
    setInsightsError(null);
    try {
      const res = await api.teacherInsights();
      setInsights(res);
      setScreen('teacher');
    } catch (e: any) {
      setInsightsError(e.message || 'Could not load teacher insights.');
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const res = await api.register({ name: authName.trim(), email: authEmail.trim(), password: authPassword, grade: authGrade });
      storeAuth(res.token, res.user);
      setAuthUser(res.user);
      setAuthMode(res.authMode);
      setProfile((p) => ({ ...p, nickname: res.user.name, class: res.user.grade }));
      setScreen('dashboard');
    } catch (err: any) {
      setAuthError(err.message || 'Could not create your account.');
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const res = await api.login({ email: authEmail.trim(), password: authPassword });
      storeAuth(res.token, res.user);
      setAuthUser(res.user);
      setAuthMode(res.authMode);
      setProfile((p) => ({ ...p, nickname: p.nickname || res.user.name, class: res.user.grade }));
      setScreen('dashboard');
    } catch (err: any) {
      setAuthError(err.message || 'Could not sign you in.');
    } finally {
      setAuthSubmitting(false);
    }
  }

  function handleLogout() {
    clearAuth();
    setAuthUser(null);
    setAuthMode(null);
    setAuthPassword('');
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setSessionId(null);
    setQuestion(null);
    setScreen('landing');
  }

  function startGuest() {
    setError(null);
    setScreen('onboarding');
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setSessionId(null);
    setQuestion(null);
    setFeedback(null);
    setHint(null);
    setMastery(null);
    setNextAction(null);
    setLessonContext(null);
    setPendingNext(null);
    setSelected(null);
    setRecap(null);
    setLessonRequest(null);
    setInsights(null);
    setDiagnosis(null);
    setResults(null);
    setPostNotice(null);
    setProfile({
      nickname: authUser ? authUser.name : '',
      class: authUser ? authUser.grade : 8,
      subject: 'mathematics',
      chapter: 'Linear Equations',
      language: 'en',
    });
    setScreen(authUser ? 'dashboard' : 'landing');
  }

  // Derived catalogue state for honest start gating.
  const activeCurriculum = curricula.find((c) => c.id === curriculumId) || curricula[0] || null;
  // Classes 6-10 are always listed; only pack-supported grades start. Never
  // imply coverage the pack has not verified (a curriculum test pins grade 9
  // as refused, so unsupported grades stay disabled, not silently served).
  const ALL_GRADES = [6, 7, 8, 9, 10];
  const supportedGrades = activeCurriculum?.supportedGrades?.length ? activeCurriculum.supportedGrades : [8];
  const selectedSubject = subjects.find((s) => s.id === profile.subject) || null;
  const selectedChapter = chapters.find((c) => c.id === selectedChapterId) || chapters[0] || null;
  const chapterReady = !!selectedChapter && (selectedChapter.coverage === 'assessment_ready' || selectedChapter.coverage === 'lesson_ready' || (selectedChapter.concepts?.length || 0) > 0);
  const catalogEmpty = !catalogLoading && subjects.length === 0;
  const isStartReady = !!profile.nickname.trim() && !!selectedChapter && chapterReady && !catalogEmpty;

  // ---------------------------------------------------------------- screens
  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <p role="status" className="text-sm text-gray-500">Loading AhaPath…</p>
      </div>
    );
  }

  if (screen === 'landing') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary-50 to-white">
        <header className="max-w-5xl mx-auto px-6 pt-6 flex items-center justify-between">
          <p className="text-2xl font-extrabold text-primary-600 tracking-tight">AhaPath</p>
          <div className="flex gap-2">
            <button
              onClick={() => { setAuthError(null); setScreen('login'); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Sign in
            </button>
            <button
              onClick={() => { setAuthError(null); setScreen('register'); }}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              Get started free
            </button>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 pb-16">
          <section className="mt-14 text-center">
            <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900 tracking-tight">
              Learn your way.<br />One step at a time.
            </h1>
            <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto">
              Every student gets the same worksheet — but no two students understand the same things.
              AhaPath finds what you understand, teaches the gaps, and adapts your next practice.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => { setAuthError(null); setScreen('register'); }}
                className="rounded-lg bg-primary-600 px-6 py-3 text-white font-semibold text-sm hover:bg-primary-700"
              >
                Create free account
              </button>
              <button
                onClick={startGuest}
                className="rounded-lg border border-gray-300 px-6 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50"
              >
                Try instant demo (no account)
              </button>
            </div>
            <p className="mt-3 text-xs text-gray-500">AP SSC curriculum · Classes 8–10 · English · Demo auth, no personal data beyond learning records.</p>
          </section>

          <section className="mt-14 grid sm:grid-cols-3 gap-4">
            <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
              <p className="text-2xl font-bold text-primary-600">1</p>
              <h2 className="mt-2 font-semibold text-gray-900">Diagnose</h2>
              <p className="mt-1 text-sm text-gray-600">Short verified quizzes measure each concept — and name the exact misconception behind a wrong answer.</p>
            </div>
            <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
              <p className="text-2xl font-bold text-primary-600">2</p>
              <h2 className="mt-2 font-semibold text-gray-900">Teach the gap</h2>
              <p className="mt-1 text-sm text-gray-600">A personal visual lesson with a concept map, worked steps and hints — matched to your class level.</p>
            </div>
            <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
              <p className="text-2xl font-bold text-primary-600">3</p>
              <h2 className="mt-2 font-semibold text-gray-900">Adapt</h2>
              <p className="mt-1 text-sm text-gray-600">The engine explains every next step and moves you easier or harder based on evidence, never guesses.</p>
            </div>
          </section>

          <section className="mt-10 rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
            <h2 className="font-semibold text-gray-900">Honest coverage</h2>
            <ul className="mt-3 space-y-2 text-sm text-gray-700">
              <li className="flex items-center gap-2"><CoverageBadge coverage="assessment_ready" /> Class 8 Mathematics — Linear Equations (5 concepts, 12 verified questions)</li>
              <li className="flex items-center gap-2"><CoverageBadge coverage="catalog_only" /> Class 10 subjects — official textbook links only, full lessons coming soon</li>
            </ul>
            <div className="mt-4 flex flex-col sm:flex-row gap-3">
              <button
                onClick={openTeacher}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Teacher insights (live demo data)
              </button>
            </div>
            {insightsError && <p role="alert" className="mt-2 text-sm text-red-600">{insightsError}</p>}
          </section>
        </main>
      </div>
    );
  }

  if (screen === 'login') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <button onClick={() => setScreen('landing')} className="text-sm text-primary-600 hover:underline">← Back to home</button>
          <h1 className="mt-2 text-3xl font-extrabold text-gray-900 tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm text-gray-600">Sign in to continue your learning journey.</p>
          <form onSubmit={handleLogin} className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium mb-2">Email</label>
              <input
                id="login-email"
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-sm font-medium mb-2">Password</label>
              <input
                id="login-password"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            {authError && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{authError}</p>}
            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 disabled:opacity-50"
            >
              {authSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="text-sm text-gray-600 text-center">
              New to AhaPath? <button type="button" onClick={() => { setAuthError(null); setScreen('register'); }} className="text-primary-600 font-medium hover:underline">Create an account</button>
            </p>
          </form>
        </div>
      </div>
    );
  }

  if (screen === 'register') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <button onClick={() => setScreen('landing')} className="text-sm text-primary-600 hover:underline">← Back to home</button>
          <h1 className="mt-2 text-3xl font-extrabold text-gray-900 tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-gray-600">Free forever for the demo. We store only your name, email, grade and learning records.</p>
          <form onSubmit={handleRegister} className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
            <div>
              <label htmlFor="reg-name" className="block text-sm font-medium mb-2">Your name</label>
              <input
                id="reg-name"
                value={authName}
                onChange={(e) => setAuthName(e.target.value)}
                placeholder="e.g. Aarav"
                maxLength={30}
                required
                autoComplete="name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="reg-email" className="block text-sm font-medium mb-2">Email</label>
              <input
                id="reg-email"
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="reg-password" className="block text-sm font-medium mb-2">Password (min 6 characters)</label>
              <input
                id="reg-password"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="reg-grade" className="block text-sm font-medium mb-2">Class</label>
              <select
                id="reg-grade"
                value={authGrade}
                onChange={(e) => setAuthGrade(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {[5, 6, 7, 8, 9, 10].map((g) => (
                  <option key={g} value={g}>Class {g}</option>
                ))}
              </select>
            </div>
            {authError && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{authError}</p>}
            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 disabled:opacity-50"
            >
              {authSubmitting ? 'Creating…' : 'Create account'}
            </button>
            <p className="text-sm text-gray-600 text-center">
              Already have an account? <button type="button" onClick={() => { setAuthError(null); setScreen('login'); }} className="text-primary-600 font-medium hover:underline">Sign in</button>
            </p>
          </form>
        </div>
      </div>
    );
  }

  if (screen === 'dashboard') {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Your dashboard</p>
              <h1 className="mt-1 text-2xl font-bold text-gray-900">
                Namaste, {authUser ? authUser.name : profile.nickname || 'learner'}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {authUser ? `${authUser.email} · Class ${authUser.grade}` : 'Guest demo'} · {authMode ? `auth ${authMode}` : 'demo auth'}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shrink-0"
            >
              Sign out
            </button>
          </div>

          <div className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold text-gray-900">Continue learning</h2>
            <p className="mt-1 text-sm text-gray-600">Class 8 Mathematics — Linear Equations is assessment-ready. Other entries are catalogue-only.</p>
            <div className="mt-4 flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => { setError(null); setScreen('onboarding'); }}
                className="flex-1 rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700"
              >
                {sessionId ? 'Resume learning' : 'Start learning'}
              </button>
              <button
                onClick={openTeacher}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50"
              >
                Teacher insights
              </button>
            </div>
            {insightsError && <p role="alert" className="mt-2 text-sm text-red-600">{insightsError}</p>}
          </div>

          <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold text-gray-900">How AhaPath works</h2>
            <ol className="mt-2 space-y-1 text-sm text-gray-700 list-decimal list-inside">
              <li>Diagnose — short verified quizzes measure each concept.</li>
              <li>Teach the gap — personal visual lesson with a concept map.</li>
              <li>Adapt — every next step is explained, easier or harder on evidence.</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'onboarding') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setScreen(authUser ? 'dashboard' : 'landing')}
              className="text-sm text-primary-600 hover:underline"
            >
              ← {authUser ? 'Dashboard' : 'Home'}
            </button>
            {authUser && <span className="text-xs text-gray-500">Signed in as {authUser.name}</span>}
          </div>
          <h1 className="mt-2 text-4xl font-extrabold text-primary-600 tracking-tight">AhaPath</h1>
          <p className="mt-2 text-gray-600">AhaPath finds what you understand, teaches the gaps, and adapts your next practice.</p>
          <p className="mt-1 text-xs text-gray-500">Demo mode — nickname only, no password. No personal data beyond learning records.</p>

          <form onSubmit={handleStart} className="mt-8 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
            <div>
              <label htmlFor="nickname" className="block text-sm font-medium mb-2">
                What should we call you?
              </label>
              <input
                id="nickname"
                value={profile.nickname}
                onChange={(e) => setProfile({ ...profile, nickname: e.target.value })}
                placeholder="e.g. Aarav"
                maxLength={20}
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            <div>
              <label htmlFor="curriculum" className="block text-sm font-medium mb-2">Board / curriculum</label>
              <select
                id="curriculum"
                value={curriculumId || ''}
                onChange={(e) => setCurriculumId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {curricula.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.board} ({c.academicYear})
                  </option>
                ))}
              </select>
              {activeCurriculum && (
                <p className="mt-2 text-xs text-gray-500">
                  Pack {activeCurriculum.id} · v{activeCurriculum.contentVersion} · {activeCurriculum.status}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Your class</label>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Class">
                {ALL_GRADES.map((cls) => {
                  const supported = supportedGrades.includes(cls);
                  return (
                    <label key={cls} title={supported ? `Class ${cls}` : `Class ${cls} — not verified yet`}>
                      <input
                        type="radio"
                        name="class"
                        value={cls}
                        checked={profile.class === cls}
                        disabled={!supported}
                        onChange={() => setProfile({ ...profile, class: cls })}
                        className="sr-only peer"
                      />
                      <span
                        className={`block text-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                          profile.class === cls
                            ? 'bg-primary-600 border-primary-600 text-white'
                            : supported
                            ? 'border-gray-300 text-gray-700 hover:border-primary-400 hover:bg-primary-50 cursor-pointer'
                            : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed'
                        }`}
                      >
                        {cls}{!supported && <span className="block text-[10px] font-normal">soon</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-gray-500">Your class decides how detailed explanations are.</p>
            </div>

            <div>
              <label htmlFor="subject" className="block text-sm font-medium mb-2">Subject</label>
              <select
                id="subject"
                value={profile.subject}
                onChange={(e) => setProfile({ ...profile, subject: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {s.coverage.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {selectedSubject && (
                <div className="mt-2 flex items-center gap-2">
                  <CoverageBadge coverage={selectedSubject.coverage} />
                  {selectedSubject.note && <span className="text-xs text-gray-500">{selectedSubject.note}</span>}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="chapter" className="block text-sm font-medium mb-2">Chapter</label>
              <select
                id="chapter"
                value={selectedChapterId || ''}
                onChange={(e) => {
                  const ch = chapters.find((c) => c.id === e.target.value);
                  setSelectedChapterId(e.target.value);
                  if (ch) setProfile((p) => ({ ...p, chapter: ch.title }));
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} — {c.coverage.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {selectedChapter && (
                <div className="mt-2 flex items-center gap-2">
                  <CoverageBadge coverage={selectedChapter.coverage} />
                  <span className="text-xs text-gray-500">
                    {selectedChapter.concepts?.length || 0} concepts
                    {selectedChapter.summary ? ` · ${selectedChapter.summary}` : ''}
                  </span>
                </div>
              )}
              {chapters.length === 0 && !catalogLoading && (
                <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 p-3">
                  <p className="text-xs text-gray-700">
                    Catalogue only — this subject has no sourced chapters yet. Official textbook links only; pick Class 8 Mathematics for the full demo.
                  </p>
                </div>
              )}
            </div>

            {concepts.length > 0 && (
              <div>
                <p className="block text-sm font-medium mb-2">What you will practise</p>
                <ul className="space-y-2">
                  {concepts.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                      <span className="text-sm text-gray-800">{c.title}</span>
                      <span className="text-xs text-gray-500">{c.questions} questions</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <label htmlFor="language" className="block text-sm font-medium mb-2">
                Explanation language
              </label>
              <select
                id="language"
                value={profile.language}
                onChange={(e) => setProfile({ ...profile, language: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {(activeCurriculum?.languages?.length ? activeCurriculum.languages : ['en']).map((l) => (
                  <option key={l} value={l}>{l === 'en' ? 'English' : l}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-gray-500">Lessons outside English fall back to reviewed English content and say so.</p>
            </div>

            {catalogLoading && (
              <p role="status" className="text-sm text-gray-500">Loading curriculum catalogue…</p>
            )}
            {catalogError && (
              <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                {catalogError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || !isStartReady}
              className="w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Starting…' : 'Start learning'}
            </button>
            {!isStartReady && !catalogLoading && (
              <p className="text-xs text-amber-700">Pick the supported Class 8 Mathematics path to start — other entries are catalogue-only.</p>
            )}

            {error && (
              <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                {error}
              </p>
            )}
          </form>

          <button
            onClick={openTeacher}
            className="mt-4 w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Teacher insights (live demo data)
          </button>
          {insightsError && (
            <p role="alert" className="mt-2 text-sm text-red-600">{insightsError}</p>
          )}
        </div>
      </div>
    );
  }

  if (screen === 'lesson' && lessonRequest) {
    return (
      <LessonScreen
        sessionId={sessionId!}
        conceptId={lessonRequest.conceptId}
        action={lessonRequest.action}
        actionReason={lessonRequest.actionReason}
        misconception={lessonRequest.misconception}
        onDone={finishLesson}
        onBack={() => {
          setLessonRequest(null);
          setScreen('quiz');
        }}
      />
    );
  }

  if (screen === 'diagnosis' && diagnosis) {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Diagnosis</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">What your answers showed</h1>
          <p className="mt-1 text-sm text-gray-600">
            Evidence from your diagnostic — single misses are possible gaps, never verdicts.
          </p>

          {diagnosis.strengths.length > 0 && (
            <div className="mt-6 rounded-2xl bg-emerald-50 border border-emerald-200 p-6">
              <h2 className="font-semibold text-emerald-900">Strengths</h2>
              <ul className="mt-2 space-y-1">
                {diagnosis.strengths.map((s) => (
                  <li key={s.conceptId} className="text-sm text-emerald-900">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-emerald-700"> · {s.mastery}% over {s.attempts} attempts</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {diagnosis.gaps.length > 0 && (
            <div className="mt-4 rounded-2xl bg-amber-50 border border-amber-200 p-6">
              <h2 className="font-semibold text-amber-900">Gaps to fix</h2>
              <ul className="mt-2 space-y-1">
                {diagnosis.gaps.map((g) => (
                  <li key={g.conceptId} className="text-sm text-amber-900">
                    <span className="font-medium">{g.label}</span>
                    <span className="text-amber-700"> · {g.mastery}% over {g.attempts} attempts</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {diagnosis.uncertain.length > 0 && (
            <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
              <h2 className="font-semibold text-gray-900">Needs more evidence</h2>
              <p className="mt-1 text-sm text-gray-600">
                {diagnosis.uncertain.map((u) => u.label).join(', ')} — one attempt is not enough to judge.
              </p>
            </div>
          )}

          {diagnosis.misconceptions.length > 0 && (
            <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
              <h2 className="font-semibold text-gray-900">Likely misconceptions</h2>
              <ul className="mt-2 space-y-2">
                {diagnosis.misconceptions.map((m) => (
                  <li key={m.code} className="text-sm text-gray-700">
                    <span className="font-medium capitalize">{m.label}</span>{' '}
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      m.confidence === 'repeated-pattern'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {m.confidence === 'repeated-pattern' ? `Repeated pattern (${m.count}×)` : 'Possible gap (seen once)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold text-gray-900">Your learning path</h2>
            <ol className="mt-3 space-y-3">
              {diagnosis.path.steps.map((step) => (
                <li key={step.order} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white text-xs font-bold">
                    {step.order}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {step.label}{' '}
                      <span className="ml-1 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700">
                        {PATH_KIND_LABEL[step.kind] || step.kind}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-gray-600">{step.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <button
            onClick={handleContinue}
            className="mt-6 w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors"
          >
            {nextAction?.lessonRequested && lessonContext ? 'See your first lesson' : 'Continue learning'}
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'results' && results) {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Results</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Before vs after</h1>
          <p className="mt-1 text-sm text-gray-600">
            Diagnostic evidence compared with your independent post-assessment. No faked progress.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-3">
            <Stat label="Diagnostic" value={results.diagnostic.accuracy !== null ? `${results.diagnostic.accuracy}%` : '—'} />
            <Stat label="Post-check" value={results.post.accuracy !== null ? `${results.post.accuracy}%` : '—'} />
            <Stat
              label="Change"
              value={results.change === null ? '—' : `${results.change >= 0 ? '+' : ''}${results.change}%`}
            />
          </div>

          {results.change !== null && results.change <= 0 && (
            <div className="mt-4 rounded-xl bg-gray-100 border border-gray-200 p-4">
              <p className="text-sm text-gray-700">
                No improvement yet — that is honest information, not failure. The concepts below show where to focus next.
              </p>
            </div>
          )}

          <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold text-gray-900">Concepts</h2>
            <ul className="mt-3 space-y-3">
              {results.perConcept.map((c) => (
                <li key={c.conceptId}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-gray-900">{c.label}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      c.demonstrated
                        ? 'bg-emerald-100 text-emerald-800'
                        : c.measured
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {c.demonstrated ? 'Demonstrated' : c.measured ? 'Needs practice' : 'Not measured yet'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Diagnostic {c.before !== null ? `${c.before}%` : '—'}
                    {' → '}post-check {c.after !== null ? `${c.after}%` : '—'}
                    {c.delta !== null && ` (${c.delta >= 0 ? '+' : ''}${c.delta}%)`}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 rounded-xl bg-primary-50 border border-primary-200 p-4">
            <h3 className="text-sm font-semibold text-primary-900">Next step</h3>
            <p className="mt-1 text-sm text-primary-900">{results.nextStep}</p>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={openProgress}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Back to progress
            </button>
            <button
              onClick={reset}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Start over (demo reset)
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'teacher') {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Teacher demonstrator</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Class insights</h1>
          <p className="mt-1 text-sm text-gray-600">
            Live aggregate from sessions on this server — no student names. {insights ? insights.note : ''}
            {insights && !insights.durable && ' In-memory only: restart clears it.'}
          </p>

          {!insights ? (
            <p role="status" className="mt-6 text-sm text-gray-500">Loading insights…</p>
          ) : (
            <>
              <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Sessions" value={insights.sessions} />
                <Stat label="Accuracy" value={`${insights.accuracy}%`} />
                <Stat label="May need review" value={insights.needsReview} />
                <Stat label="Ready for challenge" value={insights.readyForChallenge} />
              </div>

              <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
                <h2 className="font-semibold text-gray-900">Common misconceptions</h2>
                {insights.topMisconceptions.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-500">No misconceptions recorded yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {insights.topMisconceptions.map((m) => (
                      <li key={m.code} className="flex items-center justify-between text-sm">
                        <span className="font-medium capitalize text-gray-800">{m.label}</span>
                        <span className="text-gray-500">{m.count}×</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
                <h2 className="font-semibold text-gray-900">Concepts by evidence</h2>
                {insights.concepts.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-500">No attempts yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {insights.concepts.map((c) => (
                      <li key={c.conceptId} className="flex items-center justify-between text-sm">
                        <span className="text-gray-800">{c.label}</span>
                        <span className="text-gray-500">{c.correct}/{c.attempts} · {c.accuracy}%</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-gray-500">Framed as “may benefit from review” — never fixed labels about ability.</p>
              </div>
            </>
          )}

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => setScreen(sessionId ? 'progress' : 'onboarding')}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              onClick={reset}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Start over (demo reset)
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'progress') {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl">
          <h1 className="text-2xl font-bold text-gray-900">Your progress</h1>
          <p className="mt-1 text-gray-600">
            Nice work, {profile.nickname || 'student'} — here is what your answers showed.
          </p>

          {recap && (
            <>
              <div className="mt-6 grid grid-cols-3 gap-3">
                <Stat label="Answered" value={recap.answered} />
                <Stat label="Correct" value={recap.correct} />
                <Stat label="Accuracy" value={`${recap.accuracy}%`} />
              </div>

              {recap.strength && (
                <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Strongest concept</p>
                  <p className="mt-1 text-sm text-emerald-900">{recap.strength}</p>
                </div>
              )}

              <div className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
                <h2 className="font-semibold text-gray-900">Skills practised</h2>
                <ul className="mt-3 space-y-3">
                  {recap.skills.map((s) => (
                    <li key={s.conceptId}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-gray-900">{s.label}</span>
                        <span className="text-gray-500">
                          {s.correct}/{s.attempts} correct · {s.mastery}%
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            s.status === 'ready-for-challenge' ? 'bg-emerald-500' : 'bg-primary-500'
                          }`}
                          style={{ width: `${Math.max(4, s.mastery)}%` }}
                        />
                      </div>
                      <p
                        className={`mt-1 text-xs font-medium ${
                          s.status === 'ready-for-challenge' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {s.status === 'ready-for-challenge' ? 'Ready for a challenge' : 'Developing'}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>

              {recap.misconceptions.length > 0 && (
                <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
                  <h2 className="font-semibold text-gray-900">Misconceptions found</h2>
                  <ul className="mt-3 space-y-2">
                    {recap.misconceptions.map((m) => (
                      <li key={m.code} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                        <span>
                          <span className="font-medium capitalize">{m.code.replace(/-/g, ' ')}</span>{' '}
                          <span className="text-gray-500">
                            {m.count > 1 ? `· repeated pattern (${m.count}×)` : '· possible gap (seen once)'}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 rounded-xl bg-primary-50 border border-primary-200 p-4">
                <h3 className="text-sm font-semibold text-primary-900">Recommended next</h3>
                <p className="mt-1 text-sm text-primary-900">{recap.nextRecommendedAction}</p>
              </div>

              {recap.mindMap && recap.mindMap.nodes.length > 0 && (
                <div className="mt-4 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
                  <h2 className="font-semibold text-gray-900">Concept map</h2>
                  <p className="text-xs text-gray-500">Mastery state comes from your answers, not a guess.</p>
                  <div className="mt-4">
                    <MindMapDiagram
                      mindMap={recap.mindMap}
                      currentId={recap.mindMap.currentConceptId}
                      height={320}
                    />
                  </div>
                  <details className="mt-4 rounded-lg bg-gray-50 border border-gray-200 p-3">
                    <summary className="text-sm font-medium text-gray-800 cursor-pointer">Text alternative: concept states</summary>
                    <ul className="mt-2 space-y-1">
                      {recap.mindMap.nodes.map((n) => (
                        <li key={n.id} className="text-sm text-gray-700">
                          <span className="font-medium">{n.label}</span>
                          {' — '}{n.type.replace(/_/g, ' ')}
                          {n.state ? ` · ${n.state.replace(/_/g, ' ')}` : ''}
                          {typeof n.mastery === 'number' && (n.attempts || 0) > 0 ? ` · mastery ${n.mastery}%` : ' · not yet assessed'}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </>
          )}

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => void startPostAssessment()}
              disabled={submitting}
              className="flex-1 rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Take post-assessment'}
            </button>
            <button
              onClick={openResults}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              See results
            </button>
          </div>
          <div className="mt-3 flex gap-3">
            <button
              onClick={openTeacher}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Teacher view
            </button>
            <button
              onClick={reset}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
            >
              Start over (demo reset)
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- quiz
  return (
    <div className="min-h-screen p-6 flex items-start justify-center">
      <div className="w-full max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{profile.nickname || 'Student'}</h1>
            <p className="text-sm text-gray-500 capitalize">{profile.subject} · {profile.chapter}</p>
          </div>
          <div className="text-right">
            <span className="text-sm text-gray-500 whitespace-nowrap">
              {question ? `Q${question.questionIndex}/${question.totalQuestions}` : ''}
            </span>
            <p className="mt-0.5">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {phase === 'diagnostic' ? 'Diagnostic' : phase === 'post' ? 'Post-check' : 'Practice'}
              </span>
            </p>
          </div>
        </div>

        {serverBanner && (
          <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3">
            <p className="text-xs text-amber-800">{serverBanner}</p>
          </div>
        )}

        {!online && (
          <div className="mt-4 rounded-lg bg-gray-100 border border-gray-300 p-3" role="alert">
            <p className="text-xs text-gray-700">You are offline. Previously loaded reviewed lessons stay readable; live AI questions and new sessions need a connection.</p>
          </div>
        )}

        {postNotice && (
          <div className="mt-4 rounded-lg bg-sky-50 border border-sky-200 p-3">
            <p className="text-xs text-sky-900">{postNotice}</p>
          </div>
        )}

        {demoMode && (
          <div className="mt-4 rounded-lg bg-violet-50 border border-violet-200 p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-violet-900">
              Demo mode (<span className="font-semibold">{demoMode}</span>): judges — use auto-play to show divergence in 30s.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => handleDemoAnswer(false)}
                disabled={!question || !!feedback || submitting}
                className="rounded-lg border border-violet-300 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-40"
              >
                Auto wrong
              </button>
              <button
                onClick={() => handleDemoAnswer(true)}
                disabled={!question || !!feedback || submitting}
                className="rounded-lg bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40"
              >
                Auto correct
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          {loadingQuestion && !question && (
            <div role="status" className="py-16 text-center text-gray-400 text-sm">Loading question…</div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>
          )}

          {question && !feedback && (
            <>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700">
                  {question.conceptLabel}
                </span>
                {question.isTransfer && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Transfer question
                  </span>
                )}
              </div>

              <p className="mt-3 text-lg font-medium text-gray-900">{question.stem}</p>

              <div className="mt-4 space-y-2">
                {question.options.map((opt) => (
                  <label key={opt.id}>
                    <input
                      type="radio"
                      name="option"
                      value={opt.id}
                      checked={selected === opt.id}
                      onChange={() => setSelected(opt.id)}
                      className="sr-only peer"
                    />
                    <span
                      className={`block rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                        selected === opt.id
                          ? 'border-primary-500 bg-primary-50 text-primary-900'
                          : 'border-gray-200 text-gray-800 hover:border-primary-300 hover:bg-primary-50/40'
                      }`}
                    >
                      {opt.text}
                    </span>
                  </label>
                ))}
              </div>

              {hint ? (
                <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                  <span className="font-medium">Nudge: </span>{hint}
                </p>
              ) : (
                <button
                  onClick={handleHint}
                  disabled={hintLoading || submitting}
                  className="mt-3 text-sm font-medium text-primary-600 hover:underline disabled:opacity-40"
                >
                  {hintLoading ? 'Getting a nudge…' : 'Need a nudge? Show hint'}
                </button>
              )}

              <button
                onClick={() => void handleSubmit()}
                disabled={!selected || submitting}
                className="mt-6 w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? 'Checking…' : 'Submit answer'}
              </button>
            </>
          )}

          {question && feedback && nextAction && (
            <div>
              <div
                role="status"
                className={`rounded-xl p-4 border ${
                  feedback.isCorrect
                    ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                    : 'bg-amber-50 text-amber-900 border-amber-200'
                }`}
              >
                <p className="font-semibold">
                  {feedback.isCorrect ? 'Correct!' : `Not quite — the answer is ${feedback.correctAnswer}.`}
                </p>
                {feedback.explanation && (
                  <p className="mt-1 text-sm text-gray-700">{feedback.explanation}</p>
                )}
                {!feedback.isCorrect && feedback.misconceptionExplanation && (
                  <p className="mt-2 text-sm text-gray-700">
                    <span className="font-medium">What went wrong: </span>
                    {feedback.misconceptionExplanation}
                  </p>
                )}
              </div>

              {mastery && (
                <div className="mt-3 flex items-center gap-3 text-xs text-gray-500">
                  <span>{question.conceptLabel} mastery</span>
                  <span className="font-mono font-medium text-gray-700">
                    {mastery.before}% → {mastery.after}%
                  </span>
                </div>
              )}

              <div className="mt-4 rounded-xl bg-gray-50 border border-gray-200 p-4">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-800">
                    {ACTION_BLURB[nextAction.code] || 'Next'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {nextAction.difficultyDirection === 'easier'
                      ? 'easier problem'
                      : nextAction.difficultyDirection === 'harder'
                      ? 'harder problem'
                      : 'same level'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-gray-700">{nextAction.reason}</p>
              </div>

              <button
                onClick={handleContinue}
                className="mt-6 w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors"
              >
                {nextAction.lessonRequested && lessonContext
                  ? 'See your next lesson'
                  : pendingNext
                  ? `Next question (${pendingNext.questionIndex}/${pendingNext.totalQuestions})`
                  : 'See my results'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-white border border-gray-100 p-4 text-center shadow-sm">
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{label}</p>
    </div>
  );
}
