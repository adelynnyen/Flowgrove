// Remembers who is signed in, using a signed cookie.
//
// The cookie holds the person's Google id, name and email, plus an expiry date, and a "signature" made with a
// secret that only the server knows. Nobody can change the cookie (say, to pretend to be someone else) without
// the signature breaking. The secret is SESSION_SECRET if you set one in Vercel; if you didn't, it is
// derived from your GOOGLE_CLIENT_SECRET, which is already there.

import { createHmac, timingSafeEqual, createHash } from 'crypto';

const COOKIE = 'fg_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // stay signed in for 30 days

function secretKey() {
  const secret = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
  return createHash('sha256').update('flowgrove-session|' + secret).digest();
}

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function sessionSecretConfigured() {
  return !!(process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET);
}

export function readCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx === -1) continue;
    if (parts[i].slice(0, idx).trim() === name) {
      const val = parts[i].slice(idx + 1).trim();
      try { return decodeURIComponent(val); } catch (e) { return val; }
    }
  }
  return null;
}

export function makeSessionCookie(user) {
  const payload = toBase64Url(JSON.stringify({
    sub: user.sub, gsub: user.gsub || user.sub, email: user.email || '', name: user.name || '', exp: Date.now() + MAX_AGE_SECONDS * 1000
  }));
  const signature = toBase64Url(createHmac('sha256', secretKey()).update(payload).digest());
  return `${COOKIE}=${payload}.${signature}; HttpOnly; Secure; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax`;
}

// Returns { sub, gsub, email, name } for a valid, unexpired session, otherwise null.
export function getSession(req) {
  const raw = readCookie(req.headers.cookie, COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = createHmac('sha256', secretKey()).update(payload).digest();
  let given;
  try { given = fromBase64Url(signature); } catch (e) { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(fromBase64Url(payload).toString('utf8')); } catch (e) { return null; }
  if (!data || !data.sub || !data.exp || data.exp < Date.now()) return null;
  // sub = the account that owns the data; gsub = the Google account that was used to sign in
  return { sub: String(data.sub), gsub: String(data.gsub || data.sub), email: data.email || '', name: data.name || '' };
}
