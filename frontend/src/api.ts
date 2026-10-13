// API client for the AhaPath backend

const API_BASE = '/api';
export const DEBUG = import.meta.env.DEV;

export interface OnboardingData {
  nickname: string;
  class: number;
  subject: string;
  chapter: string;
  language?: string;
  curriculumId?: string;
}

export interface Profile {
  nickname: string;
  class: number;
  subject: string;
  chapter: string;
  language: string;
}

export interface Option {
  id: string;
  text: string;
}

export interface Question {
  qid: string;
  stem: string;
  conceptId: string;
  conceptLabel: string;
  difficulty: number;
  isTransfer: boolean;
  questionIndex: number;
  totalQuestions: number;
  options: Option[];
  phase?: 'diagnostic' | 'adaptive' | 'post' | 'recap';
  completed?: boolean;
}

export interface AnswerFeedback {
  isCorrect: boolean;
  chose: string;
  correctAnswer: string;
  misconception: string | null;
  misconceptionLabel: string | null;
  explanation: string;
  misconceptionExplanation: string | null;
  usedHint: boolean;
}

export interface LearningState {
  conceptId: string;
  conceptLabel: string;
  masteryBefore: number;
  masteryAfter: number;
  attempts: number;
  correct: number;
}

export interface NextAction {
  code: string;
  targetConceptId: string;
  targetConceptLabel: string;
  difficultyDirection: 'easier' | 'same' | 'harder';
  reason: string;
  misconception: string | null;
  lessonRequested: boolean;
}

export interface LessonContext {
  conceptId: string;
  action: string;
  actionReason: string;
  misconception: string | null;
  practiceOutcome: 'correct' | 'incorrect';
}

export interface AnswerResponse {
  graded: boolean;
  phase: string;
  feedback: AnswerFeedback;
  learningState: LearningState;
  nextAction: NextAction;
  lessonContext: LessonContext | null;
  nextQuestion: Question | null;
  band: { name: string; guidance: string };
}

export interface MindMapNode {
  id: string;
  label: string;
  type: 'prerequisite' | 'current' | 'target' | 'remediation';
  state?: 'not_tested' | 'developing' | 'solid' | 'needs_review';
  mastery?: number;
  attempts?: number;
}

export interface MindMapEdge {
  from: string;
  to: string;
}

export interface MindMap {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

export interface LessonStep {
  caption: string;
  content: string;
  why: string;
}

export interface Lesson {
  title: string;
  mindMap: MindMap;
  imageQuery: string;
  steps: LessonStep[];
  hint: string;
  tryNext: string;
  finalAnswer: string;
  source: 'gemini' | 'fallback';
  notice: string | null;
  reviewedProblem: string;
  expectedAnswer: string;
  conceptId: string;
  nextAction: string;
}

export interface SkillRecap {
  conceptId: string;
  label: string;
  attempts: number;
  correct: number;
  mastery: number;
  status: 'developing' | 'ready-for-challenge';
  misconception: string | null;
}

export interface ProgressRecap {
  answered: number;
  correct: number;
  accuracy: number;
  skills: SkillRecap[];
  misconceptions: { code: string; label: string; count: number }[];
  nextRecommendedAction: string;
  strength: string | null;
  mindMap?: MindMap & { currentConceptId?: string };
  conceptOrder?: string[];
}

export interface Curriculum {
  id: string;
  region: string;
  board: string;
  academicYear: string;
  defaultLanguage: string;
  languages: string[];
  supportedGrades: number[];
  contentVersion: number;
  status: string;
}

export interface SubjectEntry {
  id: string;
  title: string;
  coverage: string;
  note: string | null;
}

export interface ChapterEntry {
  id: string;
  title: string;
  coverage: string;
  summary: string | null;
  concepts: { id: string; title: string; coverage: string }[];
}

export interface ConceptEntry {
  id: string;
  title: string;
  description: string | null;
  learningObjectives: string[];
  prerequisiteConceptIds: string[];
  recommendedDifficulty: number;
  estimatedMinutes: number | null;
  questions: number;
  resources: number;
}

export interface ResourceEntry {
  id: string;
  type: string;
  title: string;
  language: string;
  url: string | null;
  publisher: string | null;
  licence: string | null;
  reviewStatus: string;
}

export interface DiagnosisSkill {
  conceptId: string;
  label: string;
  attempts: number;
  correct?: number;
  mastery?: number;
}

export interface MisconceptionFinding {
  code: string;
  label: string;
  count: number;
  confidence: 'possible-gap' | 'repeated-pattern';
}

export interface PathStep {
  order: number;
  action: string;
  kind: 'lesson' | 'practice' | 'assessment' | 'advance';
  conceptId: string;
  label: string;
  reason: string;
  count?: number;
}

export interface Diagnosis {
  strengths: DiagnosisSkill[];
  gaps: DiagnosisSkill[];
  uncertain: DiagnosisSkill[];
  misconceptions: MisconceptionFinding[];
  path: { focusConceptId: string; steps: PathStep[] };
  policyVersion: number;
}

export interface ConceptResult {
  conceptId: string;
  label: string;
  diagnosticAttempts: number;
  diagnosticCorrect: number;
  before: number | null;
  postAttempts: number;
  postCorrect: number;
  after: number | null;
  delta: number | null;
  measured: boolean;
  demonstrated: boolean;
  needsPractice: boolean;
}

export interface Results {
  diagnostic: { answered: number; correct: number; accuracy: number | null };
  post: { answered: number; correct: number; accuracy: number | null };
  change: number | null;
  perConcept: ConceptResult[];
  demonstrated: string[];
  needsPractice: string[];
  unmeasured: string[];
  nextStep: string;
  policyVersion: number;
}

export interface TeacherInsights {  scope: string;
  durable: boolean;
  sessions: number;
  answered: number;
  correct: number;
  accuracy: number;
  readyForChallenge: number;
  needsReview: number;
  topMisconceptions: { code: string; label: string; count: number }[];
  concepts: { conceptId: string; label: string; attempts: number; correct: number; accuracy: number }[];
  note: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  grade: number;
  createdAt: number;
}

const TOKEN_KEY = 'ahapath-token';
const USER_KEY = 'ahapath-user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function storeAuth(token: string, user: AuthUser) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // ignore — demo still works in-memory for this tab
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body.
  }
  if (!res.ok) {
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return body;
}

export const api = {
  async health() {
    return request('/health') as Promise<{
      status: string;
      timestamp: string;
      geminiConfigured: boolean;
      supportedChapter: string;
    }>;
  },

  async createSession(data: OnboardingData) {
    return request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    }) as Promise<{ sessionId: string; profile: Profile; phase: string; firstQuestion: Question | null; userId?: string | null }>;
  },

  async register(data: { name: string; email: string; password: string; grade: number }) {
    return request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }) as Promise<{ token: string; user: AuthUser; authMode: string }>;
  },

  async login(data: { email: string; password: string }) {
    return request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }) as Promise<{ token: string; user: AuthUser; authMode: string }>;
  },

  async me() {
    return request('/auth/me', {
      headers: { ...authHeaders() },
    }) as Promise<{ user: AuthUser; authMode: string }>;
  },

  async getQuestion(sessionId: string) {
    return request(`/session/${sessionId}/question`) as Promise<Question | { completed: true; phase: string }>;
  },

  async getHint(sessionId: string) {
    return request(`/session/${sessionId}/hint`) as Promise<{ qid: string; hint: string }>;
  },

  async submitAnswer(sessionId: string, questionId: string, optionId: string, usedHint = false) {
    return request(`/session/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, optionId, usedHint }),
    }) as Promise<AnswerResponse>;
  },

  async getLesson(sessionId: string, conceptId: string, action: string, variant?: 'analogy' | 'steps') {
    return request(`/session/${sessionId}/lesson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptId, action, variant: variant || 'default' }),
    }) as Promise<{ lesson: Lesson }>;
  },

  async getProgress(sessionId: string) {
    return request(`/session/${sessionId}/progress`) as Promise<{
      recap: ProgressRecap;
      profile: Profile;
      phase: string;
      nextRecommendedAction: string;
    }>;
  },

  async getDiagnosis(sessionId: string) {
    return request(`/session/${sessionId}/diagnosis`) as Promise<{
      sessionId: string;
      phase: string;
      hasEvidence: boolean;
      snapshot: {
        concepts: Record<string, { attempts: number; correct: number; mastery: number }>;
        answered: number;
        correct: number;
        accuracy: number;
      } | null;
      diagnosis: Diagnosis;
    }>;
  },

  async startPostAssessment(sessionId: string) {
    return request(`/session/${sessionId}/post-assessment/start`, {
      method: 'POST',
    }) as Promise<{
      sessionId: string;
      phase: string;
      question: Question | null;
      totalInPost: number;
      retake: boolean;
      notice: string;
    }>;
  },

  async getResults(sessionId: string) {
    return request(`/session/${sessionId}/results`) as Promise<{
      sessionId: string;
      phase: string;
      profile: Profile;
      curriculumId: string;
      results: Results;
      policyVersion: number;
    }>;
  },

  async listCurricula() {
    return request('/curricula') as Promise<{ curricula: Curriculum[] }>;
  },

  async listSubjects(curriculumId: string, grade: number) {
    return request(`/curricula/${encodeURIComponent(curriculumId)}/grades/${grade}/subjects`) as Promise<{
      curriculumId: string;
      grade: number;
      subjects: SubjectEntry[];
    }>;
  },

  async listChapters(curriculumId: string, grade: number, subjectId: string) {
    return request(
      `/subjects/${encodeURIComponent(subjectId)}/chapters?curriculumId=${encodeURIComponent(curriculumId)}&grade=${grade}`
    ) as Promise<{ curriculumId: string; grade: number; subjectId: string; chapters: ChapterEntry[] }>;
  },

  async listConcepts(curriculumId: string, grade: number, subjectId: string, chapterId: string) {
    return request(
      `/chapters/${encodeURIComponent(chapterId)}/concepts?curriculumId=${encodeURIComponent(curriculumId)}&grade=${grade}&subjectId=${encodeURIComponent(subjectId)}`
    ) as Promise<{ curriculumId: string; chapterId: string; concepts: ConceptEntry[] }>;
  },

  async listResources(curriculumId: string, conceptId: string) {
    return request(
      `/concepts/${encodeURIComponent(conceptId)}/resources?curriculumId=${encodeURIComponent(curriculumId)}`
    ) as Promise<{
      curriculumId: string;
      conceptId: string;
      conceptTitle: string;
      hasVerifiedVideo: boolean;
      message: string;
      resources: ResourceEntry[];
    }>;
  },

  async teacherInsights() {
    return request('/teacher/insights') as Promise<TeacherInsights>;
  },
};
