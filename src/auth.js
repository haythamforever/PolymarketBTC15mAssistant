import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const USERS_FILE = './data/users.json';
const SECRET_FILE = './data/.session_secret';

/* ── Session Secret ───────────────────────────────────── */

export function getSessionSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) return s;
    }
  } catch { /* ignore */ }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  } catch { /* ignore */ }
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

/* ── User Storage ─────────────────────────────────────── */

export function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

export function hasAnyUsers() {
  return loadUsers().length > 0;
}

export async function createUser(username, password, role = 'admin') {
  const users = loadUsers();
  if (users.find(u => u.username === username)) {
    throw new Error('User already exists');
  }
  const hash = await hashPassword(password);
  const user = { username, hash, role, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  console.log(`  [auth] created user: ${username} (${role})`);
  return { username, role };
}

export async function authenticateUser(username, password) {
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user) return null;
  const valid = await verifyPassword(password, user.hash);
  return valid ? { username: user.username, role: user.role } : null;
}
