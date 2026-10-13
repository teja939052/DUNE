/**
 * Session persistence.
 *
 * MongoDB Atlas is the source of truth when a connection string is configured.
 * An in-memory Map sits in front as a read-through/write-through cache so the
 * request handlers stay simple and fast.
 *
 * If no connection string is configured, or Atlas is unreachable, the store
 * falls back to memory only and says so through `mongoState`. The learning
 * journey keeps working either way; only cross-restart durability is lost.
 */

import mongoose from 'mongoose';

const SCHEMA_VERSION = 1;

const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    profile: { type: Object, default: {} },
    model: { type: Object, default: {} },
    phase: { type: String, default: 'diagnostic' },
    currentSkillId: { type: String, default: null },
    currentDifficulty: { type: Number, default: 1 },
    lastDecision: { type: Object, default: null },
    pendingQuestion: { type: Object, default: null },
    // Stage-tagged evidence + post-assessment state (additive; old sessions
    // without them still load — handlers default to {} / null / []).
    stageEvidence: { type: Object, default: {} },
    diagnosticSnapshot: { type: Object, default: null },
    postQueue: { type: Array, default: [] },
    schemaVersion: { type: Number, default: SCHEMA_VERSION },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { minimize: false }
);

export const SessionModel =
  mongoose.models.LearningSession || mongoose.model('LearningSession', sessionSchema);

export const mongoState = {
  status: 'disabled', // disabled | connecting | connected | error
  error: null,
  uri: null,
  connectedAt: null,
  lastWriteAt: null,
};

/** In-memory cache, always populated regardless of Mongo state. */
const cache = new Map();

/** Connect to Atlas. Never throws — reports state instead. */
export async function connectMongo(uri, { timeoutMs = 15000 } = {}) {
  if (!uri) {
    mongoState.status = 'disabled';
    mongoState.error = 'No MONGODB_URI configured';
    console.log('[mongo] No MONGODB_URI set — using in-memory sessions.');
    return false;
  }

  mongoState.status = 'connecting';
  mongoState.uri = uri.replace(/\/\/[^@]*@/, '//***:***@'); // never log credentials
  console.log(`[mongo] Connecting to ${redact(uri)} …`);

  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      maxPoolSize: 10,
      family: 4,
    });
    mongoState.status = 'connected';
    mongoState.error = null;
    mongoState.connectedAt = Date.now();
    console.log(`[mongo] Connected to database "${mongoose.connection.name}".`);
    return true;
  } catch (err) {
    mongoState.status = 'error';
    mongoState.error = err.message;
    console.error(`[mongo] Connection failed, continuing in memory only: ${err.message}`);
    return false;
  }
}

function redact(uri) {
  return String(uri).replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

export function mongoEnabled() {
  return mongoState.status === 'connected';
}

/** Strip Mongoose internals and re-derive the plain session object. */
function toPlainSession(doc) {
  const json = typeof doc?.toJSON === 'function' ? doc.toJSON() : doc;
  return { ...json };
}

/** Load a session: cache first, then Atlas. */
export async function loadSession(sessionId) {
  if (!sessionId) return undefined;

  const cached = cache.get(sessionId);
  if (cached) return cached;

  if (!mongoEnabled()) return undefined;

  try {
    const doc = await SessionModel.findOne({ sessionId }).lean();
    if (!doc) return undefined;
    const session = toPlainSession(doc);
    cache.set(sessionId, session);
    return session;
  } catch (err) {
    console.error(`[mongo] loadSession failed for ${sessionId}: ${err.message}`);
    return undefined;
  }
}

/**
 * Persist a session. Always updates the cache; writes to Atlas only when reachable.
 * Fires the write without awaiting it so the response is not slowed by the DB,
 * but surfaces failures in state for debugging.
 */
export function saveSession(session) {
  if (!session?.sessionId) return;
  cache.set(session.sessionId, session);

  if (!mongoEnabled()) return;

  const payload = { ...session, updatedAt: Date.now() };
  SessionModel.updateOne({ sessionId: session.sessionId }, payload, { upsert: true })
    .then(() => {
      mongoState.lastWriteAt = Date.now();
    })
    .catch((err) => {
      console.error(`[mongo] saveSession failed for ${session.sessionId}: ${err.message}`);
    });
}

/** Remove a session from both layers. */
export async function deleteSession(sessionId) {
  cache.delete(sessionId);
  if (!mongoEnabled()) return;
  try {
    await SessionModel.deleteOne({ sessionId });
  } catch (err) {
    console.error(`[mongo] deleteSession failed: ${err.message}`);
  }
}

/** How many sessions are currently tracked in the cache. */
export function sessionCount() {
  return cache.size;
}

/** All tracked sessions (for evidence-based teacher insights — no PII leaves here). */
export function allSessions() {
  return [...cache.values()];
}

/** Drop the oldest cached session (only used when nothing durable is configured). */
export function evictOldest() {
  const oldest = cache.keys().next().value;
  if (!oldest) return false;
  cache.delete(oldest);
  return true;
}

/** Health snapshot for the API and for demo debugging. */
export function mongoHealth() {
  return {
    status: mongoState.status,
    target: mongoState.uri,
    error: mongoState.error,
    connectedAt: mongoState.connectedAt,
    lastWriteAt: mongoState.lastWriteAt,
    durable: mongoEnabled(),
  };
}

/** Connection listeners so Atlas dropping out is visible immediately. */
mongoose.connection.on('disconnected', () => {
  if (mongoState.status === 'connected') {
    mongoState.status = 'error';
    mongoState.error = 'Connection to MongoDB Atlas was lost';
    console.error('[mongo] Disconnected from Atlas — falling back to in-memory sessions.');
  }
});

mongoose.connection.on('error', (err) => {
  console.error(`[mongo] Driver error: ${err.message}`);
});

mongoose.connection.on('reconnected', () => {
  mongoState.status = 'connected';
  mongoState.error = null;
  console.log('[mongo] Reconnected to Atlas.');
});
