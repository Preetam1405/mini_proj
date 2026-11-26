'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 7;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

const DUMMY = hashPassword('not-a-real-password');

/** Always does the same amount of work, so a missing account cannot be told apart by timing. */
async function verifyPassword(password, stored) {
  const useStored = typeof stored === 'string' && stored.startsWith('scrypt$');
  const [, saltHex, keyHex] = (useStored ? stored : await DUMMY).split('$');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'));
  const ok = crypto.timingSafeEqual(expected, actual);
  return useStored && ok;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  db.prepare('INSERT INTO sessions(id, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function lookupSession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.gender, u.status, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
    return null;
  }
  if (row.status !== 'active') return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, gender: row.gender || null, status: row.status };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
}

/** Checks a Google ID token with Google and confirms it was issued for this app. */
async function verifyGoogleIdToken(idToken, clientId) {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) throw new Error('Google rejected the sign-in.');
  const c = await res.json();
  if (c.aud !== clientId) throw new Error('This Google sign-in was not issued for this app.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('Unexpected Google issuer.');
  if (!(c.email_verified === true || c.email_verified === 'true')) throw new Error('Your Google email is not verified.');
  if (Number(c.exp) * 1000 < Date.now()) throw new Error('The Google sign-in has expired.');
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: c.name || String(c.email) };
}

/** Small in-memory limiter for login attempts. Use a shared store if you run several servers. */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < now) return true;
      return h.count < max;
    },
    fail(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else h.count++;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = { hashPassword, verifyPassword, createSession, lookupSession, destroySession, verifyGoogleIdToken, makeLimiter, sha };
