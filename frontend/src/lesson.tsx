import React from 'react';
import { api } from '@/api';
import type { Lesson } from '@/api';
import { MindMapDiagram } from '@/mindmap';

/** The visual lesson screen. */
export interface LessonScreenProps {
  sessionId: string;
  conceptId: string;
  action: string;
  actionReason: string;
  misconception: string | null;
  onDone: () => void;
  onBack: () => void;
}

export function LessonScreen({
  sessionId,
  conceptId,
  action,
  actionReason,
  misconception,
  onDone,
  onBack,
}: LessonScreenProps) {
  const [lesson, setLesson] = React.useState<Lesson | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [revealedHint, setRevealedHint] = React.useState(false);
  const [activeStep, setActiveStep] = React.useState(0);
  const [variant, setVariant] = React.useState<'default' | 'analogy' | 'steps'>('default');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { lesson } = await api.getLesson(sessionId, conceptId, action, variant === 'default' ? undefined : variant);
        if (!cancelled) setLesson(lesson);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Could not load the lesson.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, conceptId, action, variant]);

  if (isLoading) {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-3xl">
          <div role="status" className="py-24 text-center text-gray-400 text-sm">
            Building your lesson…
          </div>
        </div>
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div className="min-h-screen p-6 flex items-start justify-center">
        <div className="w-full max-w-3xl mt-12">
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-4">
            {error || 'Lesson unavailable.'}
          </p>
          <button
            onClick={onBack}
            className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to practice
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 flex items-start justify-center">
      <div className="w-full max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">
              Your personalised lesson
            </p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">{lesson.title}</h1>
          </div>
          <span
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
              lesson.source === 'gemini'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-amber-50 text-amber-800 border border-amber-200'
            }`}
          >
            {lesson.source === 'gemini' ? 'AI generated' : 'Reviewed lesson'}
          </span>
        </div>

        {/* Why this lesson exists. */}
        <div className="mt-4 rounded-xl bg-primary-50 border border-primary-200 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Why this lesson</p>
          <p className="mt-1 text-sm text-primary-900">{actionReason}</p>
          {misconception && (
            <p className="mt-2 text-xs text-primary-800">
              Working on: <span className="font-medium">{misconception.replace(/-/g, ' ')}</span>
            </p>
          )}
        </div>

        {lesson.notice && (
          <div className="mt-3 rounded-xl bg-gray-50 border border-gray-200 p-3">
            <p className="text-xs text-gray-600">{lesson.notice}</p>
          </div>
        )}

        {/* Explain differently: refetches the same concept in another style. */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Still stuck?</span>
          <button
            onClick={() => setVariant('analogy')}
            disabled={isLoading || variant === 'analogy'}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Explain with an analogy
          </button>
          <button
            onClick={() => setVariant('steps')}
            disabled={isLoading || variant === 'steps'}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Explain in steps
          </button>
        </div>

        {/* Visual concept map. */}
        <section className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-semibold text-gray-900">Concept map</h2>
          <p className="text-xs text-gray-500">
            Follow the arrows from what you already need to what you are learning.
          </p>
          <div className="mt-4">
            <MindMapDiagram mindMap={lesson.mindMap} currentId={lesson.conceptId} height={340} />
          </div>
          <details className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
            <summary className="text-sm font-medium text-gray-800 cursor-pointer">Text alternative: concept map</summary>
            <ul className="mt-2 space-y-1">
              {lesson.mindMap.nodes.map((n) => (
                <li key={n.id} className="text-sm text-gray-700">
                  <span className="font-medium">{n.label}</span>{' — '}{n.type.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-gray-500">
              Edges: {lesson.mindMap.edges.map((e) => `${e.from} → ${e.to}`).join('; ')}
            </p>
          </details>
          <p className="mt-2 text-center text-xs text-gray-400">
            {lesson.mindMap.nodes.length} concepts · {lesson.mindMap.edges.length} prerequisite paths
          </p>
        </section>

        {/* Procedural flowchart, built only from the approved worked steps. */}
        <section className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-semibold text-gray-900">Solving flowchart</h2>
          <p className="text-xs text-gray-500">
            The same approved steps as a path: start with the equation, follow each move, then verify.
          </p>
          <ol className="mt-4 space-y-0">
            <FlowNode
              first
              title="Start"
              body={lesson.reviewedProblem}
            />
            {lesson.steps.map((s, i) => (
              <FlowNode key={i} title={`Step ${i + 1}: ${s.caption}`} body={s.content} />
            ))}
            <FlowNode last title="Verify" body={`Check: ${lesson.finalAnswer}`} />
          </ol>
          <details className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
            <summary className="text-sm font-medium text-gray-800 cursor-pointer">Text alternative: flowchart</summary>
            <ol className="mt-2 space-y-1 list-decimal list-inside">
              <li className="text-sm text-gray-700">Start with {lesson.reviewedProblem}.</li>
              {lesson.steps.map((s, i) => (
                <li key={i} className="text-sm text-gray-700">{s.caption}: {s.content}</li>
              ))}
              <li className="text-sm text-gray-700">Verify the solution ({lesson.finalAnswer}).</li>
            </ol>
          </details>
        </section>

        {/* Worked example with captioned steps. */}        <section className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-semibold text-gray-900">Worked example</h2>
          <p className="mt-1 text-lg font-mono text-gray-900">{lesson.reviewedProblem}</p>

          <ol className="mt-4 space-y-3">
            {lesson.steps.map((step, i) => (
              <li key={i}>
                <button
                  onClick={() => setActiveStep(i)}
                  className="w-full text-left rounded-lg border border-gray-200 hover:border-primary-300 transition-colors"
                >
                  <div
                    className={`flex gap-3 p-3 ${activeStep === i ? 'bg-primary-50' : 'bg-white'}`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        activeStep === i ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{step.caption}</p>
                      <p className="mt-0.5 text-sm font-mono text-gray-800">{step.content}</p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ol>

          {lesson.steps[activeStep] && (
            <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Why this step</p>
              <p className="mt-1 text-sm text-gray-700">{lesson.steps[activeStep].why}</p>
            </div>
          )}
        </section>

        {/* Hint. */}
        <section className="mt-6 rounded-2xl bg-white shadow-sm border border-gray-100 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Hint</h2>
              <p className="text-xs text-gray-500">A nudge, not the answer.</p>
            </div>
            <button
              onClick={() => setRevealedHint((v) => !v)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {revealedHint ? 'Hide hint' : 'Show hint'}
            </button>
          </div>
          {revealedHint && (
            <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
              {lesson.hint}
            </p>
          )}
        </section>

        {/* Try next. */}
        <section className="mt-6 rounded-2xl border-2 border-primary-200 bg-primary-50 p-6">
          <h2 className="text-sm font-semibold text-primary-900">Try next</h2>
          <p className="mt-1 text-sm text-primary-900">{lesson.tryNext}</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary-700">Answer</span>
            <span className="font-mono text-lg font-bold text-primary-900">{lesson.finalAnswer}</span>
          </div>
        </section>

        <button
          onClick={onDone}
          className="mt-6 w-full rounded-lg bg-primary-600 px-4 py-3 text-white font-semibold text-sm hover:bg-primary-700 transition-colors"
        >
          Start practice
        </button>
      </div>
    </div>
  );
}

/** One box in the vertical solving flowchart, joined by a CSS arrow. */
function FlowNode({ title, body, first, last }: { title: string; body: string; first?: boolean; last?: boolean }) {
  return (
    <li className="flex flex-col items-stretch">
      {!first && (
        <span aria-hidden="true" className="mx-auto text-lg leading-6 text-primary-400">↓</span>
      )}
      <div
        className={`rounded-xl border px-4 py-3 ${
          first
            ? 'border-primary-300 bg-primary-50'
            : last
            ? 'border-emerald-300 bg-emerald-50'
            : 'border-gray-200 bg-white'
        }`}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
        <p className="mt-0.5 text-sm font-medium text-gray-900">{body}</p>
      </div>
    </li>
  );
}
