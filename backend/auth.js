/**
 * Demo-grade platform auth.
 *
 * Email + password accounts with scrypt-hashed passwords (never stored or
 * logged in plain text). Tokens are random bearer strings kept in memory and,
 * when MongoDB is configured, mirrored to a users collection so accounts can
 * survive restarts. Without MongoDB, accounts live only in this process —
 * the API says so and the UI labels auth as demo auth.
 *
 * Sessions stay backward compatible: POST /api/session works without a token
 * (existing tests), and links `userId` when a valid `Authorization: Bearer`
 * token is supplied.
 */

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mongoEnabled, SessionModel } from './store.js';
import mongoose from 'mongoose';

const usersByEmail = new Map(); // emailLower -> user record (includes passHash)
const usersById = new Map(); // id -> user record
const tokens = new Map(); // token -> userId

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, required: true, unique: true, index: true },
    grade: { type: Number, default: 8 },
    passHash: { type: String, required: true },
    salt: { type: String, required: true },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { minimize: false }
);

export const UserModel =
  mongoose.models.PlatformUser || mongoose.model('PlatformUser', userSchema);

function newId() {
  return `usr-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function newToken() {
  return `ahp_${randomBytes(32).toString('hex')}`;
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function authMode() {
  return mongoEnabled() ? 'durable' : 'memory-only';
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, grade: user.grade, createdAt: user.createdAt };
}

async function persistUser(user) {
  if (!mongoEnabled()) return;
  try {
    await UserModel.updateOne(
      { userId: user.id },
      { userId: user.id, name: user.name, email: user.email, grade: user.grade, passHash: user.passHash, salt: user.salt, createdAt: user.createdAt },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[auth] persist failed for ${user.email}: ${err.message}`);
  }
}

async function loadUserByEmail(emailLower) {
  const cached = usersByEmail.get(emailLower);
  if (cached) return cached;
  if (!mongoEnabled()) return null;
  try {
    const doc = await UserModel.findOne({ email: emailLower }).lean();
    if (!doc) return null;
    const user = { id: doc.userId, name: doc.name, email: doc.email, grade: doc.grade, passHash: doc.passHash, salt: doc.salt, createdAt: doc.createdAt };
    usersByEmail.set(emailLower, user);
    usersById.set(user.id, user);
    return user;
  } catch (err) {
    console.error(`[auth] load failed: ${err.message}`);
    return null;
  }
}

export async function registerUser({ name, email, password, grade }) {
  const cleanName = String(name || '').trim().slice(0, 30);
  const cleanEmail = String(email || '').trim().toLowerCase();
  const klass = Number(grade);
  if (!cleanName) return { ok: false, status: 400, error: 'Name is required.' };
  if (!validEmail(cleanEmail)) return { ok: false, status: 400, error: 'Enter a valid email address.' };
  if (typeof password !== 'string' || password.length < 6) {
    return { ok: false, status: 400, error: 'Password must be at least 6 characters.' };
  }
  if (!Number.isInteger(klass) || klass < 5 || klass > 10) {
    return { ok: false, status: 400, error: 'Grade must be between 5 and 10.' };
  }

  const existing = await loadUserByEmail(cleanEmail);
  if (existing) return { ok: false, status: 409, error: 'An account with this email already exists. Try signing in.' };

  const salt = randomBytes(16).toString('hex');
  const user = {
    id: newId(),
    name: cleanName,
    email: cleanEmail,
    grade: klass,
    passHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  usersByEmail.set(cleanEmail, user);
  usersById.set(user.id, user);
  await persistUser(user);

  const token = newToken();
  tokens.set(token, user.id);
  return { ok: true, token, user: publicUser(user) };
}

export async function loginUser({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!validEmail(cleanEmail) || typeof password !== 'string' || !password) {
    return { ok: false, status: 400, error: 'Enter your email and password.' };
  }
  const user = await loadUserByEmail(cleanEmail);
  if (!user) return { ok: false, status: 401, error: 'No account found for this email. Try registering first.' };
  const attempt = hashPassword(password, user.salt);
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(user.passHash, 'hex');
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match) return { ok: false, status: 401, error: 'Wrong password. Try again.' };
  const token = newToken();
  tokens.set(token, user.id);
  return { ok: true, token, user: publicUser(user) };
}

export function userForToken(token) {
  if (!token) return null;
  const id = tokens.get(token);
  if (!id) return null;
  return usersById.get(id) || null;
}

export function bearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Sessions created with a token get linked to the account; anonymous still works. */
export function linkSessionToUser(session, req) {
  const user = userForToken(bearerToken(req));
  if (user) {
    session.userId = user.id;
    if (!session.profile) session.profile = {};
    if (!session.profile.email) session.profile.email = user.email;
  }
  return session;
}
