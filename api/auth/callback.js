// Handles Google's redirect back. There are two reasons someone can arrive here:
//   1) They connected Google Calendar (state starts with a plain id). We swap the code for calendar access
//      tokens and keep them in secure, HTTP-only cookies.
//   2) They signed in to Flowfill (state starts with "login."). We ask Google who they are and remember them
//      with a signed session cookie. No calendar access is involved.
//   3) They added a second Google account (state starts with "link."), e.g. home + school, so both open the
//      same tasks.
//
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET

// Must exactly match the constant in api/auth/google.js and the URI
// registered in Google Cloud Console.

import { makeSessionCookie, getSession } from '../_lib/session.js';
import { storeConfigured, resolveOwner, getUserRecord, setUserRecord, deleteUserRecord, getIdentities, setIdentities, deleteIdentities, setLink } from '../_lib/store.js';
import { mergeData } from '../_lib/merge.js';
import { appDomain } from '../_lib/app.js';

const MAX_LINKED_ACCOUNTS = 3;

const CLEAR_STATE_COOKIE = 'fg_oauth_state=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax';
const CLEAR_LOGIN_COOKIE = 'fg_login_state=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax';
const CLEAR_LINK_COOKIE = 'fg_link_state=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax';

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (e) { return v; }
}

function readCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx === -1) continue;
    if (parts[i].slice(0, idx).trim() === name) return safeDecode(parts[i].slice(idx + 1).trim());
  }
  return null;
}

function redirect(res, location, cookies) {
  res.setHeader('Set-Cookie', cookies || [CLEAR_STATE_COOKIE]);
  res.writeHead(302, { Location: location });
  res.end();
}

// Swaps Google's one-time code for the person's identity (id, name, email). Used by both sign-in and
// "add another Google account". The id_token comes straight from Google over a secure connection, so its
// contents can be trusted; we still check that it is for our app and not expired.
async function exchangeForClaims(code, domain) {
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${domain}/api/auth/callback`,
      grant_type: 'authorization_code'
    })
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok || !tokenData.id_token) return { error: 'token_exchange_failed' };
  const parts = String(tokenData.id_token).split('.');
  const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issuerOk || claims.aud !== process.env.GOOGLE_CLIENT_ID || !claims.sub || (claims.exp && claims.exp * 1000 < Date.now())) {
    return { error: 'bad_token' };
  }
  return { claims: claims };
}

// ----- Signing in (identity only) -----
async function handleLogin(req, res) {
  const clearLogin = [CLEAR_LOGIN_COOKIE];
  if (req.query.error) {
    return redirect(res, '/index.html?login_error=' + encodeURIComponent(String(req.query.error)), clearLogin);
  }
  const code = req.query.code;
  const savedState = readCookie(req.headers.cookie, 'fg_login_state');
  if (!code || !savedState || savedState !== req.query.state) {
    return redirect(res, '/index.html?login_error=bad_state', clearLogin);
  }
  try {
    const result = await exchangeForClaims(code, appDomain(req));
    if (result.error) return redirect(res, '/index.html?login_error=' + result.error, clearLogin);
    const claims = result.claims;
    // If this Google account was added to another one (home + school), the data belongs to the first one.
    let owner = claims.sub;
    if (storeConfigured()) owner = await resolveOwner(claims.sub);
    const cookies = [CLEAR_LOGIN_COOKIE, makeSessionCookie({ sub: owner, gsub: claims.sub, email: claims.email, name: claims.name || claims.given_name || '' })];
    return redirect(res, '/index.html?signed_in=1', cookies);
  } catch (err) {
    return redirect(res, '/index.html?login_error=server_error', clearLogin);
  }
}

// ----- Adding another Google account to the one you're signed in with -----
async function handleLink(req, res) {
  const back = function(query) { return redirect(res, '/index.html?' + query, [CLEAR_LINK_COOKIE]); };
  if (req.query.error) return back('link_error=' + encodeURIComponent(String(req.query.error)));
  const session = getSession(req);
  if (!session) return back('link_error=not_signed_in');
  const savedState = readCookie(req.headers.cookie, 'fg_link_state');
  if (!req.query.code || !savedState || savedState !== req.query.state) return back('link_error=bad_state');
  if (!storeConfigured()) return back('link_error=db_not_configured');
  try {
    const result = await exchangeForClaims(req.query.code, appDomain(req));
    if (result.error) return back('link_error=' + result.error);
    const claims = result.claims;
    const A = await resolveOwner(session.sub);   // the account you are signed in to
    const B = claims.sub;                        // the Google account you just proved is yours
    const bOwner = await resolveOwner(B);
    if (B === A || bOwner === A) return back('linked=already');
    if (bOwner !== B) return back('link_error=other_account'); // it already belongs to a different account

    let idsA = await getIdentities(A);
    if (!idsA || !idsA.length) idsA = [{ sub: A, email: session.email, name: session.name, addedAt: Date.now() }];
    if (idsA.length >= MAX_LINKED_ACCOUNTS) return back('link_error=too_many');
    const idsB = (await getIdentities(B)) || [];

    // If that Google account already had its own tasks, combine them with these (nothing is thrown away).
    const recB = await getUserRecord(B);
    if (recB) {
      const recA = await getUserRecord(A);
      const merged = mergeData(recA ? recA.data : null, recB.data);
      await setUserRecord(A, { rev: (recA ? recA.rev : 0) + 1, updatedAt: Date.now(), data: merged });
    }
    idsA.push({ sub: B, email: claims.email || '', name: claims.name || claims.given_name || '', addedAt: Date.now() });
    for (let i = 0; i < idsB.length; i++) {
      if (idsB[i].sub !== B && idsA.length < MAX_LINKED_ACCOUNTS) { await setLink(idsB[i].sub, A); idsA.push(idsB[i]); }
    }
    await setLink(B, A);
    await setIdentities(A, idsA);
    if (recB) await deleteUserRecord(B);
    await deleteIdentities(B);
    return back('linked=1');
  } catch (err) {
    return back('link_error=server_error');
  }
}

export default async function handler(req, res) {
  const stateStart = String(req.query.state || '');
  if (stateStart.startsWith('login.')) return handleLogin(req, res);
  if (stateStart.startsWith('link.')) return handleLink(req, res);

  // ----- Connecting Google Calendar -----
  // The person clicked "Cancel"/"Deny" on Google's screen.
  if (req.query.error) {
    return redirect(res, '/index.html?calendar_error=' + encodeURIComponent(String(req.query.error)));
  }

  const code = req.query.code;
  if (!code) {
    return redirect(res, '/index.html?calendar_error=missing_code');
  }

  // Check the one-time state from google.js: it must match the cookie we set.
  const savedState = readCookie(req.headers.cookie, 'fg_oauth_state');
  if (!savedState || savedState !== req.query.state) {
    return redirect(res, '/index.html?calendar_error=bad_state');
  }

  const redirectUri = `${appDomain(req)}/api/auth/callback`;

  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok) {
      return redirect(res, '/index.html?calendar_error=token_exchange_failed');
    }

    const lifetime = tokenData.expires_in || 3600;
    const cookies = [CLEAR_STATE_COOKIE];
    cookies.push(`fg_access_token=${tokenData.access_token}; HttpOnly; Secure; Path=/; Max-Age=${lifetime}; SameSite=Lax`);
    if (tokenData.refresh_token) {
      // Refresh tokens are long-lived; only returned the first time a user
      // consents (or after revoking access), so we only overwrite it if present.
      cookies.push(`fg_refresh_token=${tokenData.refresh_token}; HttpOnly; Secure; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    cookies.push(`fg_access_token_expires=${Date.now() + (lifetime * 1000)}; HttpOnly; Secure; Path=/; Max-Age=${lifetime}; SameSite=Lax`);

    return redirect(res, '/index.html?calendar_connected=1', cookies);
  } catch (err) {
    return redirect(res, '/index.html?calendar_error=server_error');
  }
}
