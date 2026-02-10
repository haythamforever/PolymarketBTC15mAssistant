import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbGetUserByUsername, dbCreateUser, dbHasAnyUsers, dbGetSessionSecret, dbSetSessionSecret } from './db/queries.js';

const USERS_FILE = './data/users.json';
const SECRET_FILE = './data/.session_secret';

/* ── Session Secret ───────────────────────────────────── */

export async function getSessionSecret() {
  // Try DB first
  try {
    const dbSecret = await dbGetSessionSecret();
    if (dbSecret && dbSecret.length >= 32) return dbSecret;
  } catch { /* fall through to file */ }

  // File-based fallback
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) {
        // Persist to DB if available
        dbSetSessionSecret(s).catch(() => {});
        return s;
      }
    }
  } catch { /* ignore */ }

  // Generate new secret
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  } catch { /* ignore */ }
  dbSetSessionSecret(secret).catch(() => {});
  return secret;
}

/* ── Password Hashing (scrypt) ────────────────────────── */

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(salt + ':' + key.toString('hex'));
    });
  });
}

export function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(key === derivedKey.toString('hex'));
    });
  });
}

/* ── User Storage (DB with file fallback) ─────────────── */

function loadUsersFile() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveUsersFile(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

export async function hasAnyUsers() {
  try {
    const dbResult = await dbHasAnyUsers();
    if (dbResult !== null) return dbResult; // DB answered
  } catch { /* fall through */ }
  return loadUsersFile().length > 0;
}

export async function createUser(username, password, role = 'admin') {
  const hash = await hashPassword(password);

  // Try DB first
  try {
    const dbResult = await dbCreateUser(username, hash, role);
    if (dbResult) {
      console.log(`  [auth] created user (DB): ${username} (${role})`);
      return { username: dbResult.username, role: dbResult.role };
    }
  } catch (err) {
    // If it's a unique constraint violation, throw
    if (err?.code === '23505') throw new Error('User already exists');
    // Otherwise fall through to file
    console.error(`  [auth] DB create failed, falling back to file: ${err.message}`);
  }

  // File-based fallback
  const users = loadUsersFile();
  if (users.find(u => u.username === username)) {
    throw new Error('User already exists');
  }
  const user = { username, hash, role, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsersFile(users);
  console.log(`  [auth] created user (file): ${username} (${role})`);
  return { username, role };
}

export async function authenticateUser(username, password) {
  // Try DB first
  try {
    const dbUser = await dbGetUserByUsername(username);
    if (dbUser !== null) {
      // DB is available
      if (dbUser === undefined) return null; // user not found
      const valid = await verifyPassword(password, dbUser.hash);
      return valid ? { username: dbUser.username, role: dbUser.role } : null;
    }
  } catch { /* fall through to file */ }

  // File-based fallback
  const users = loadUsersFile();
  const user = users.find(u => u.username === username);
  if (!user) return null;
  const valid = await verifyPassword(password, user.hash);
  return valid ? { username: user.username, role: user.role } : null;
}
