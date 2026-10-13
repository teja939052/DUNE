/**
 * Curriculum metadata for the supported demo chapter.
 *
 * The adaptive engine is deterministic and server-authoritative. Everything in
 * this file is reviewed, server-controlled content: the engine reads it, uses it
 * to build Gemini prompts, and validates Gemini's output against it.
 */

/**
 * Concept graph for Linear Equations. These are real prerequisite
 * relationships, not decoration.
 */
export const concepts = {
  "number-sense": {
    label: "Number Sense",
    type: "prerequisite",
    description: "Doing the same operation to both sides keeps an equation balanced.",
  },
  "inverse-operations": {
    label: "Inverse Operations",
    type: "prerequisite",
    description: "Use the opposite operation to move a term across the equals sign.",
  },
  "distributive-parenthesis": {
    label: "Distributive Property",
    type: "prerequisite",
    description: "Multiply the outside term by every term inside brackets.",
  },
  "two-step-equations": {
    label: "Two-Step Equations",
    type: "current",
    description: "Undo addition first, then undo multiplication by dividing.",
  },
  "variables-both-sides": {
    label: "Variables on Both Sides",
    type: "target",
    description: "Gather like terms on one side before solving.",
  },
};

/** Prerequisite edges for the concept mind map. */
export const conceptEdges = [
  { from: "number-sense", to: "inverse-operations" },
  { from: "inverse-operations", to: "distributive-parenthesis" },
  { from: "distributive-parenthesis", to: "two-step-equations" },
  { from: "two-step-equations", to: "variables-both-sides" },
];

/** Ordered difficulty progression of concepts. */
export const conceptOrder = [
  "number-sense",
  "inverse-operations",
  "distributive-parenthesis",
  "two-step-equations",
  "variables-both-sides",
];

/**
 * Reading bands keyed on the class the student selected. Controls register and
 * sentence length in the Gemini prompt only — never the grade.
 */
export const readingBands = [
  { min: 5, max: 6, name: "simple",
    guidance: "Use very simple words and short sentences. Use everyday objects like sharing sweets or a see-saw as analogies. Avoid notation the student has not met." },
  { min: 7, max: 8, name: "clear",
    guidance: "Use clear everyday language and step-by-step reasoning. Name each move you make and say why it keeps the equation balanced." },
  { min: 9, max: 10, name: "formal",
    guidance: "Use correct mathematical notation and concise formal reasoning. State steps compactly without extra hand-holding." },
];

export function bandForClass(klass) {
  return readingBands.find((b) => klass >= b.min && klass <= b.max) || readingBands[1];
}

/** Human-readable explanation for every misconception code in the bank. */
export const misconceptionExplanations = {
  "wrong-inverse-operation":
    "Use the opposite operation to move a term: subtract to undo addition, add to undo subtraction, divide to undo multiplication.",
  "forgot-divide-by-coefficient":
    "After you isolate the x-term you still have to divide both sides by the number multiplying x.",
  "arithmetic-error":
    "Your method was right — check the arithmetic.",
  "ignored-left-side":
    "Whatever you do to the right side you must also do to the left side.",
  "ignored-right-side":
    "Simplify the right side too — gather the x terms on one side and the numbers on the other.",
  "ignored-constant":
    "Deal with the plain number term first by adding or subtracting it from both sides.",
  "ignored-parentheses":
    "Start by distributing the outside number over every term inside the brackets.",
  "distributed-incorrectly":
    "When distributing, multiply the outside number by every term inside the brackets.",
  "partially-distributed":
    "Distribute to all terms inside the brackets, not just the first one.",
  "combined-constants-incorrectly":
    "Combine the plain number terms carefully — subtract a negative means you add.",
  "combined-like-terms-incorrectly":
    "Only combine terms with the same variable. Subtract the coefficients, not the letters.",
  "wrong-operation-order":
    "Undo addition or subtraction first, then undo multiplication or division.",
  "misread-problem":
    "Translate the words into an equation first — decide what x stands for, then build the equation.",
  "divided-instead-of-multiplied":
    "When x is being divided, multiply both sides to undo it.",
  "added-instead-of-subtracted":
    "Check the sign: a minus on one side becomes adding when you move it across.",
  "subtracted-instead-of-added":
    "To undo subtraction, add the same amount to both sides.",
  "added-coefficients-incorrectly":
    "When you move a variable term across, its sign flips.",
  "ignored-variables-side":
    "Group the x terms on one side before you solve.",
  "halved-incorrectly":
    "Halve both sides, not just one.",
  "multiplied-by-wrong-number":
    "Multiply by the number x is being divided by.",
  "forgot-multiply-both-sides":
    "Multiply every term on both sides, not just the x term.",
  "forgot-add-constant":
    "Don't forget the constant term still needs to be moved across.",
  "divided-before-subtracting":
    "Do the addition or subtraction step first, then the division.",
};

/**
 * Reviewed lesson anchors, one per concept. These supply the worked example,
 * the canonical final answer the engine checks Gemini against, and a reviewed
 * fallback mind map.
 */
export const lessonAnchors = {
  "number-sense": {
    sourceExampleId: "number-sense-worked-example",
    title: "Keeping the Equation Balanced",
    workedExample: { problem: "x + 5 = 12", finalAnswer: "x = 7" },
    steps: [
      { caption: "Name the goal", content: "Get x on its own on the left side.", why: "An equation is solved when the variable stands alone." },
      { caption: "Undo the +5", content: "Subtract 5 from both sides: x = 12 − 5.", why: "Subtracting is the opposite of adding, so it removes the +5." },
      { caption: "Finish", content: "x = 7.", why: "12 − 5 is 7, and both sides are still balanced." },
    ],
    hint: "What is the opposite of adding 5? Do it to BOTH sides.",
    mindMap: [
      { id: "ns-core", label: "Balance both sides", type: "current" },
      { id: "ns-inv", label: "Add / Subtract moves", type: "target" },
    ],
    mindMapEdges: [{ from: "ns-inv", to: "ns-core" }],
  },
  "inverse-operations": {
    sourceExampleId: "inverse-operations-worked-example",
    title: "Undoing Multiplication and Division",
    workedExample: { problem: "2x = 14", finalAnswer: "x = 7" },
    steps: [
      { caption: "Spot the multiplier", content: "The 2 is being multiplied with x.", why: "To free x you need the opposite of multiplying." },
      { caption: "Undo it", content: "Divide both sides by 2: x = 14 ÷ 2.", why: "Division undoes multiplication exactly." },
      { caption: "Finish", content: "x = 7.", why: "14 divided by 2 is 7." },
    ],
    hint: "2x means 2 × x. Which operation cancels × 2?",
    mindMap: [
      { id: "io-core", label: "Inverse operations", type: "current" },
      { id: "io-soon", label: "Two-step equations", type: "target" },
    ],
    mindMapEdges: [{ from: "io-core", to: "io-soon" }],
  },
  "distributive-parenthesis": {
    sourceExampleId: "distributive-parenthesis-worked-example",
    title: "Removing Brackets Correctly",
    workedExample: { problem: "3(x + 2) = 21", finalAnswer: "x = 5" },
    steps: [
      { caption: "Distribute", content: "3 × x and 3 × 2 gives 3x + 6, so 3x + 6 = 21.", why: "The number outside brackets multiplies every term inside." },
      { caption: "Undo the +6", content: "Subtract 6 from both sides: 3x = 15.", why: "Now it is a two-step equation." },
      { caption: "Undo the ×3", content: "Divide both sides by 3: x = 5.", why: "Division undoes the multiplication." },
    ],
    hint: "The 3 must reach BOTH x and 2. Which one is easy to forget?",
    mindMap: [
      { id: "dp-core", label: "Distribute first", type: "current" },
      { id: "dp-soon", label: "Two-step equations", type: "target" },
    ],
    mindMapEdges: [{ from: "dp-core", to: "dp-soon" }],
  },
  "two-step-equations": {
    sourceExampleId: "two-step-equations-worked-example",
    title: "Solving Two-Step Equations",
    workedExample: { problem: "2x + 4 = 10", finalAnswer: "x = 3" },
    steps: [
      { caption: "Undo the +4", content: "Subtract 4 from both sides: 2x = 6.", why: "Removing the constant isolates the x term." },
      { caption: "Undo the ×2", content: "Divide both sides by 2: x = 3.", why: "Division undoes the multiplication on x." },
      { caption: "Check", content: "2(3) + 4 = 10, so x = 3 is correct.", why: "Substituting back verifies the answer." },
    ],
    hint: "Two moves: first the plain number, then divide. Don't stop at 2x = 6.",
    mindMap: [
      { id: "ts-core", label: "Subtract, then divide", type: "current" },
      { id: "ts-soon", label: "Variables on both sides", type: "target" },
    ],
    mindMapEdges: [{ from: "ts-core", to: "ts-soon" }],
  },
  "variables-both-sides": {
    sourceExampleId: "variables-both-sides-worked-example",
    title: "Variables on Both Sides",
    workedExample: { problem: "5x - 7 = 2x + 8", finalAnswer: "x = 5" },
    steps: [
      { caption: "Gather the x terms", content: "Subtract 2x from both sides: 3x - 7 = 8.", why: "One side must hold all the variables." },
      { caption: "Gather the numbers", content: "Add 7 to both sides: 3x = 15.", why: "Now the x term is isolated." },
      { caption: "Finish", content: "Divide both sides by 3: x = 5.", why: "Division undoes the multiplication." },
    ],
    hint: "Move the 2x across first — and remember its sign flips.",
    mindMap: [
      { id: "vb-core", label: "Gather like terms", type: "current" },
      { id: "vb-soon", label: "Challenge", type: "target" },
    ],
    mindMapEdges: [{ from: "vb-core", to: "vb-soon" }],
  },
}
