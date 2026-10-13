# AhaPath — Implementation Report (single-pass build run)

Date: 2026-10-12. Baseline: verified backend core (engine, curriculum pack, Gemini abstraction, session API, in-memory/Mongo store)
with green unit tests; incomplete: curriculum journey UI, CLI scripts, README/report, persistence verification, demo hardening.

## What works end to end

Student: demo sign-in (nickname) → curriculum/board/year → grade → subject (coverage badge) → chapter (coverage badge,
concept preview with question counts) → diagnostic (verified bank, one-at-a-time, shuffled options, no key leak) →
skill-gap feedback (mastery before/after, misconception + explanation, next-action reason) → personalized visual lesson
(mind map + text alternative, hint, worked steps, fallback notice when applicable) → guided practice (deterministic next
question) → progress dashboard (mastery bars, misconceptions, recommendation, concept map with states) → teacher view link.
Catalogue-only paths (e.g. Class 10) are labelled and cannot start a session.

Teacher view (if implemented): yes — `GET /api/teacher/insights`, aggregate-only (sessions, accuracy, review/challenge
counts, top misconceptions, per-concept attempts), no names, labelled live data from this server instance.

## Coverage truth

Fully supported: `IN.AP-SSC.2024-25` (Andhra Pradesh Board of Secondary Education, academic year 2024–25) → Class 8 →
Mathematics → Linear Equations in One Variable: 5 concepts, 4 prerequisite edges, 12 verified questions,
misconception-by-option data, reviewed lesson anchors and resources.
Catalogue-only: Class 10 Mathematics, Biological Sciences, Physical Sciences, English, Telugu, Hindi, Social Studies —
official textbook URLs only, zero chapters/concepts/questions (by design, not missing).

## Changed / created files

- `backend/package.json`: added `curriculum:validate/seed/report`, `test`, `test:engine/curriculum/lesson/integration/demo/all`.
- `backend/index.js`: `CONTENT_NOT_READY` guard (grade with zero verified questions refused); fixed `chapterId`/`conceptId`
  param schemas (routes previously never validated); `GET /api/teacher/insights` aggregate endpoint;
  `DIAGNOSTIC_COUNT` env override for fast demo; imports `ADAPTATION_CONFIG`, `allSessions`.
- `backend/engine.js`: `correctQuestionIds[]` tracked on correct answers; `passedTransferFor` requires a *correct* transfer
  answer (was: merely served); `selectNextQuestion` falls back to unseen material instead of repeating a served question.
- `backend/config.js`: documented `diagnosticQuestionCount: 12` default + `DIAGNOSTIC_COUNT=4` demo mode.
- `backend/store.js`: added `allSessions()` for aggregate insights.
- `frontend/src/api.ts`: `curriculumId` on onboarding; `listCurricula/Subjects/Chapters/Concepts/Resources`,
  `teacherInsights`; `MindMapNode.state/mastery/attempts`; `ProgressRecap.mindMap/conceptOrder`; new catalogue/teacher types.
- `frontend/src/App.tsx`: curriculum-driven onboarding (board/year, grades from pack, subjects/chapters with
  `CoverageBadge`, concept preview, honest catalogue-only block, language from pack); `?demo=weak/strong` auto-play;
  fixed session-resume `JSON.parse`; progress mind map + text alternative; teacher screen; offline banner; dynamic header.
- `frontend/src/lesson.tsx`: text alternative for the lesson mind map (nodes + edges).
- `README.md`: rewritten to match actual code (features vs planned, mermaid architecture, coverage matrix, setup, commands,
  deterministic-vs-AI, demo walkthrough, limitations, pack guide, security).
- Root `IMPLEMENTATION_REPORT.md`: this file.

## Commands run and results

- `npm run curriculum:validate` → PASS (1 pack valid, 12 verified questions, 0 errors).
- `npm run curriculum:report` → PASS (1 assessment_ready chapter; 7 catalog_only subjects).
- `npm run test:all` (curriculum + engine + lesson-ai) → PASS (engine two-student divergence, lesson validation/cache all PASS).
- `node integration.test.mjs` (live server) → ALL INTEGRATION TESTS PASSED.
- `node two-student-demo.mjs` (live server) → TWO-STUDENT DEMO VERIFIED (A: targeted-review + lesson; B: harder-challenge, no lesson).
- Custom E2E (curricula → subjects → chapters → concepts → grade-10 refusal → 12-correct journey → lesson/progress-mindmap/teacher) → 15/15 PASS.
- `npm run build` (frontend) → PASS (tsc + vite, ~180 kB JS).
- `test-phase1.mjs` → not run standalone (requires live server; covered by integration + custom E2E instead).

## Persistence check

Result: MongoDB LIVE and restart-persistence VERIFIED (2026-10-12).
Method: `backend/.env` holds a direct Atlas URI (SRV form failed on this machine's Node DNS with
`querySrv ECONNREFUSED`, so the connection uses shard hosts + `replicaSet=atlas-11jpyo-shard-0` resolved from the
pack's TXT record). `/api/health` reports `mongo.status=connected, durable=true`. Created session, answered
(mastery 67), restarted backend, re-fetched `/progress` → `answered=1, accuracy=100`, session intact.
`npm run curriculum:seed` twice against Atlas → identical upsert summary, no duplicates.
In-memory fallback still verified separately (404 after restart without URI). Fixed along the way:
`curriculum/cli.js` never loaded dotenv, so seed ignored `backend/.env` — now imports `dotenv/config`.

## AI check

Live Gemini: NOT TESTED (no `GEMINI_API_KEY` in environment) — marked blocked, not claimed.
Fallback: VERIFIED — `lesson-ai.test.mjs` (failing/invalid provider → reviewed fallback, schema enforcement, cache bounds)
all PASS; live E2E lessons returned `fallback` source with accurate notice; `/api/health` reports `geminiConfigured=false`
and UI shows fallback banner.

## How to run locally

```bash
cd backend && npm install && cp .env.example .env && npm run dev        # :3001
# optional fast demo: DIAGNOSTIC_COUNT=4 npm run dev
cd frontend && npm install && npm run dev                                # :5173
```

Open `http://localhost:5173/?demo=weak` (and `?demo=strong` in a second tab).

## Remaining blockers

1. No `GEMINI_API_KEY` available in this environment — live AI remains unverified (fallback verified instead).
   Needs the key in `backend/.env` + a live lesson check. MongoDB is now connected and verified (see above).
2. Single supported chapter — any other class/subject is catalogue-only until new packs are authored and validated.

## Next best improvement (learning impact)

Author one more verified chapter in the same pack format (e.g. Class 8 Algebraic Expressions, 10–12 questions with
misconception mapping + lesson anchors) and validate with existing CLI/tests. This doubles the adaptive surface
(prerequisite chains across chapters) without any engine rewrite — the highest learning-impact next step.

## Addendum — platform pass (landing + auth + dashboard + AGENTS.md)

Backend: `backend/auth.js` (scrypt password hashing, random bearer tokens, memory store + best-effort Mongo
`PlatformUser` mirror), routes `POST /api/auth/register` (201, 409 on duplicate), `POST /api/auth/login`
(401 on wrong password), `GET /api/auth/me` (Bearer), Zod schemas in `schemas.js`; `POST /api/session` links
`userId` when a valid token is supplied and still works anonymously (all prior tests unaffected).
Frontend: `landing` (hero, 3-step how-it-works, honest coverage, teacher link), `login`, `register`
(name/email/password min-6/grade), `dashboard` (greeting, profile, resume/start, teacher link, sign out);
token + user in localStorage, `Authorization: Bearer` sent on session creation; `?demo=weak/strong` bypasses
auth to guest onboarding; onboarding prefills from account and links back to dashboard.
Auth E2E (live server) 9/9 PASS: register + token, authMode memory-only, duplicate 409, login + fresh token,
wrong password 401, me without hash leak, bad token 401, authed session carries `userId`, anonymous session
still works. Regression after change: `test:all` PASS, `integration.test.mjs` ALL PASSED, frontend build PASS.
Env docs: `backend/.env.example` now covers `DIAGNOSTIC_COUNT`, `CONTENT_PACK_ROOT`, `TEST_BASE` and notes auth
needs no extra variables; added `frontend/.env.example` (no secrets belong in `VITE_*` vars).
Also wrote `AGENTS.md` (architecture, commands, 8 conventions, pack guide, screens checklist) and updated
README for the platform journey. Guest demo and all prior flows preserved.

## Addendum — 30-minute rescue pass (content repair + prompts + deploy files)

Content emergency: an externally added NCERT pack plus new AP-SSC grade dirs broke validation (22 errors), and the
verified `pack.json` had been rewritten with a false CBSE board, a generic NCERT source and false "verified against
textbooks" provenance; `questions.json` was replaced with malformed, mislabelled items reusing stable ids (`le-05`…).
Response, per honesty rules: restored the verified `pack.json` verbatim; rebuilt `questions.json` (12 verified items,
exact keys/answers/misconceptions), `chapters.json` (1 chapter), `concepts.json` (5 concepts, linear chain ending in
`variables-both-sides` so challenge/next-concept behaviour is unchanged), `resources.json` (single verified AP
textbook link replacing 8 unreviewed third-party URLs); fixed a false NCERT note in `subjects.json`.
`misconceptions.json`, `lesson-anchors.json` and Class 10 catalogue files were intact and kept. Unreviewed additions
(NCERT, AP-SSC classes 5/6/7/9, class-10/mathematics) quarantined to `content-packs/_staging/` (manifests renamed so
the loader ignores them) with graduation criteria in `_staging/README.md`. Nothing invented; Class 10 stays
catalogue-only.
AI prompts: `providers/gemini.provider.js` system instruction replaced with a production teaching prompt (mission,
source/scope rules, personalization from evidence, structure, output contract) and the user prompt now carries board,
objective, mastery estimate, recent-attempts summary, misconception explanation, failed approach, approved anchors and
an explain-style variant — response schema untouched. `lesson-generator.js` builds this evidence from server state and
versions the cache key (`PROMPT_VERSION=2`). New `variant` (`analogy`/`steps`) flows through `lessonRequestSchema`,
route and cache for the "Explain differently" buttons.
UI: `GET /api/session/:id/hint` (nudge only, 409 without a staged question) + quiz Hint button with `usedHint`
reported on submit; lesson screen Analogy/Steps refetch.
Deploy: root `render.yaml` (repo-root service so `content-packs/` ships; `npm --prefix backend ci/start`;
`/api/health`), `frontend/vercel.json` (`/api` → Render placeholder, then SPA fallback), server binds `0.0.0.0`,
README deployment guide added. Production client already uses relative `/api`.
Verification this pass: `curriculum:validate` OK (12 verified, 0 errors); `test:all` PASS; `integration.test.mjs` ALL
PASSED; `two-student-demo.mjs` VERIFIED; new-routes live E2E 7/7 (le-01 first, nudge≠answer, wrong→misconception,
usedHint recorded, double-wrong→lesson, variant validates, fallback honest); frontend build PASS; `vercel.json`
JSON-valid. No live deploy claimed (owner must connect Render/Vercel + replace placeholder + set secrets).

## Addendum — SHIKSHA-AI core-loop pass (diagnosis + post-assessment + results)

Prompt: build the connected student journey end to end (diagnosis → learning path → visual lesson →
guided practice → post-assessment → measured results), reuse working code, no fabricated content.
Gap analysis found the diagnostic→practice→recap loop existed but three loop pieces were missing;
all were implemented as small deterministic diffs under the one-rule (LLM still phrases only):

- Backend `engine.js`: `buildDiagnosis` (strengths / gaps / uncertain-single-attempt / misconceptions
  labelled `possible-gap` vs `repeated-pattern`), `buildLearningPath` (ordered steps, every step links
  a real concept and carries its reason), `buildPostQueue` (unseen verified questions first, honest
  flagged retakes when the 12-question bank is exhausted, capped), `buildResults` (per-concept
  before/after, demonstrated / needs-practice / unmeasured, never fakes flat progress).
  Thresholds added to `config.js` `postAssessment` only — no literals elsewhere.
- Backend `index.js`: stage-tagged `stageEvidence` per answer; `diagnosticSnapshot` frozen at the
  diagnostic→adaptive flip; `GET diagnosis`, `POST post-assessment/start`, `GET results`;
  `GET question` serves the post queue in `post` phase. Answer/lesson/progress payloads unchanged
  (additive only). `store.js` schema gained the three fields so durable Mongo writes keep them.
- Frontend: `diagnosis` screen (auto-shown when the diagnostic ends), `results` screen (before/after,
  change, revisit list, next step), post-assessment entry + Post-check badge + retake notice,
  solving flowchart in the lesson built only from approved steps (with text alternative),
  class picker lists 6–10 with unverified grades disabled (a curriculum test pins grade 9 refused,
  so the pack was not touched), misconception confidence labels (`possible gap (seen once)` vs
  `repeated pattern (N×)`).
- Deliberately not built: AI-drafted diagnostic/post questions (the prompt's own fallback clause
  applies — grading reads the verified bank only); node-state renaming (existing
  `not_tested/developing/solid/needs_review` vocabulary kept, tests pin it); retries-by-design,
  speed-as-evidence, and all listed out-of-scope items (feeds, streaks, payments, …) — none added.
- Verification this pass: `curriculum:validate` OK; `test:all` PASS incl. 16 new engine checks
  (diagnosis/path/divergence/single-miss-uncertainty/queue-branches/results-honesty);
  `integration.test.mjs` ALL PASSED incl. 15 new checks (diagnosis content, divergent paths,
  409 with no evidence, staged post answers, results before/after, honest unmeasured);
  `two-student-demo.mjs` VERIFIED; frontend build PASS. Fixed along the way: `totalInPost`
  counted post-shift (off by one), and a pre-existing order-dependent flake in the integration
  wrong-option pick (shuffled options) — now deterministic by question id, 3/3 stable runs.
  Known limit unchanged: a full 12-question diagnostic leaves only retakes for the post-check;
  `DIAGNOSTIC_COUNT=8` (or `4` demo) gives distinct post questions — now documented in README.
