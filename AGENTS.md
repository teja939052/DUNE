# AGENTS.md — AhaPath contributor guide

Read this before changing anything. AhaPath is a curriculum-aware adaptive learning **platform**
(landing → auth → dashboard → diagnostic → lesson → practice → progress → teacher insights),
not a generic chatbot wrapper. Its edge is measured understanding + explainable adaptation.

## The one rule

The **deterministic engine decides WHAT to teach next; the LLM only phrases HOW**.
Never let model output change grading, mastery, question selection, or teaching order.
Every next-action must carry: action code, concept id, reason codes, evidence
(attempt/question ids), mastery before/after, policy version, and a student-facing reason.

## Architecture

```
frontend/src/          React + Vite + TS + Tailwind, screen state machine in App.tsx
  App.tsx              landing | login | register | dashboard | onboarding | quiz | diagnosis | lesson | progress | results | teacher
  api.ts               typed client; token in localStorage, Bearer on authed calls
  lesson.tsx           validated lesson render (mind map + text alternative + solving flowchart from approved steps)
  mindmap.tsx          SVG concept map from server graph (never invented client-side)
backend/
  index.js             Express routes (auth, curriculum, session, diagnosis, lesson, post-assessment, results, teacher)
  engine.js            grading, mastery, 5-rule policy, question selection, mind-map state,
                       diagnosis + learning-path builder, post queue, before/after results
  config.js            SINGLE source of thresholds (ADAPTATION_CONFIG, incl. postAssessment) — no literals elsewhere
  auth.js              demo-grade email/password auth (scrypt, bearer tokens, memory + optional Mongo)
  lesson-generator.js  context build → provider → validate → cache → reviewed fallback
  providers/           transport only (Gemini adapter); no policy or prompts here
  curriculum/          pack loader, Zod schemas, CLI (validate/seed/report)
   store.js             sessions: MongoDB when MONGODB_URI set, else in-memory (says so in /api/health)
                        + stageEvidence (per-phase attempts), diagnosticSnapshot, postQueue
content-packs/         versioned source of truth (IN.AP-SSC.2024-25: Class 8 Linear Equations full;
                       Class 10 catalogue-only by design — official links, zero invented chapters)
```

## Commands

```bash
cd backend
npm run curriculum:validate && npm run curriculum:report
npm run test:all                  # unit: curriculum + engine + lesson-ai (no server)
npm start                         # :3001  (DIAGNOSTIC_COUNT=4 for fast demo)
node integration.test.mjs         # live HTTP journey (needs server)
node two-student-demo.mjs         # divergence proof (needs server)

cd frontend
npm run dev                       # :5173 (proxies /api)   demo: /?demo=weak | /?demo=strong
npm run build                     # must pass before any PR
```

## Conventions (violations get reverted)

1. **Answer keys stay server-side.** `publicQuestion()` strips `answerId`, misconception maps, explanations.
   Client-submitted correctness/mastery is never trusted; grading recomputes from the canonical bank.
2. **Stable ids forever.** Never renumber question/option/concept ids; tests assert exact keys (`le-01…le-12`).
3. **Thresholds live in `config.js` only.** UI reads server-returned state; no duplicated constants.
4. **Honest coverage.** Badges (`assessment_ready`, `lesson_ready`, `catalog_only`) derive from pack data.
   Never invent chapters, questions, URLs, or locale strings. Missing content gets an explicit unavailable state.
5. **Fallbacks, not failures.** No key/offline/invalid AI output → reviewed lesson + accurate notice.
   Never claim live AI when serving fallback; never leak provider errors or secrets.
6. **Auth is demo-grade.** scrypt hashes, bearer tokens, no PII beyond name/email/grade/records.
   Sessions work anonymously (tests depend on it); valid tokens link `userId`. Teacher insights are aggregate-only, no names.
7. **Smallest coherent diffs.** Reuse modules/conventions. No new frameworks, vector DBs, or agent scaffolding
   without a test-backed reason. Keep rate limits sane; keep logs free of keys and student text.
8. **Prove it.** After backend changes: unit tests + (if routes touched) integration + demo script.
   After frontend changes: `npm run build`. Document blocked live tests (Mongo/Gemini) instead of faking them.

## Adding a content pack

Copy the Class 8 folder layout (`concepts`, `questions` with misconception-by-option, `lesson-anchors`,
`resources`, `chapters`) + `pack.json` entry → `curriculum:validate` → `curriculum:report`.
Seed upserts by stable id; re-runs must not duplicate. Student grading reads ONLY the approved bank —
LLM drafts stay in authoring flows until validated.

## Screens checklist (new UI must satisfy)

Mobile-first · keyboard-operable options · visible focus · loading/empty/error/retry states ·
no color-only meaning (mind maps ship a text alternative) · no dead buttons · offline banner when
`navigator.onLine === false` (reviewed content readable, live AI disabled).
