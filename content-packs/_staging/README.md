# _staging — quarantined content (NOT served)

These packs were moved here because they fail `npm run curriculum:validate`
and break the verified baseline. The loader ignores this directory (staged
manifests are renamed to `pack.json.STAGED`).

## Why each is here

- `NCERT-2025-26`: manifest lists `grade-06…grade-10` dirs that do not exist;
  `grade-05/chapters.json` records fail schema checks. Nothing here is served.
- `AP-SSC-2024-25-class-05/06/07/09`: new, unreviewed, schema-failing content.
- `AP-SSC-2024-25-class-10-mathematics`: unreviewed addition; Class 10 stays
  catalogue-only until chapters are genuinely sourced and reviewed.

A previous `pack.json` edit also relabelled the verified AP-SSC pack as CBSE
with a generic NCERT source and false "verified against textbooks" provenance.
That manifest was restored; the real sources are the AP School Education
catalogue page + Class 8 textbook PDFs named in the live `pack.json`.

## Graduation criteria (all required)

1. `pack.json` names the real board, real source URLs, real review status —
   no generic sources, no `fileReference`-style invented fields, no false provenance.
2. Every record passes `curriculum:validate` (schema + references + no cycles).
3. Every question has 4 options, one valid `correctOptionId`, and a
   misconception code per distractor; answers recomputed by the test suite.
4. Class 10 (or any new grade) ships chapters ONLY from a citable official
   chapter list; otherwise it stays `catalog_only`.
5. Re-run `test:all` + integration + two-student demo green before serving.

## Re-quarantine log (2026-10-13)

Unreviewed content had reappeared inside the LIVE tree (`IN/AP-SSC/2024-25/class-06`,
`class-07`, `class-09`, `class-10/mathematics`, `IN/NCERT/grade-07…10`). It was inert
(no manifest references it; validate/tests green; live API served nothing from it)
but violated quarantine hygiene, so it was moved here:
- `AP-SSC-2024-25-class-06/mathematics/` ← live chapters/concepts/questions/resources
  (merged beside the existing `subjects.json` skeleton; no files overwritten).
- `AP-SSC-2024-25-class-07/` and `AP-SSC-2024-25-class-09/` ← full live
  chapters/concepts/questions/resources/subjects sets into the empty skeletons.
- `AP-SSC-2024-25-class-10-mathematics/mathematics/` ← full live 5-file set.
- `NCERT-2025-26/2025-26/` ← live `grade-08/09/10` wholesale plus live `grade-07`
  chapters/concepts/questions/resources (staging `grade-07` held only
  `catalogue.json`, so nothing was overwritten).
Nothing was deleted; graduation criteria above still apply to every file here.
