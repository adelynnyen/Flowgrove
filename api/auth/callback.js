// Handles Google's redirect back. There are two reasons someone can arrive here:
//   1) They connected Google Calendar (state starts with a plain id). We swap the code for calendar access
//      tokens and keep them in secure, HTTP-only cookies.
//   2) They signed in to Flowgrove (state starts with "login."). We ask Google who they are and remember them
//      with a signed session cookie. No calendar access is involved.
//
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET

// Must exactly match the constant in api/auth/google.js and the URI
// registered in Google Cloud Console.
const APP_DOMAIN = 'https://flowgrove.vercel.app';

import { makeSessionCookie } from '../_lib/session.js';

const CLEAR_STATE_COOKIE = 'fg_oauth_state=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax';
const CLEAR_LOGIN_COOKIE = 'fg_login_state=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax';

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
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_DOMAIN}/api/auth/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.id_token) {
      return redirect(res, '/index.html?login_error=token_exchange_failed', clearLogin);
    }
    // The id_token came straight from Google over a secure connection, so its contents can be trusted.
    // We still check that it is for our app and not expired.
    const parts = String(tokenData.id_token).split('.');
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issuerOk || claims.aud !== process.env.GOOGLE_CLIENT_ID || !claims.sub || (claims.exp && claims.exp * 1000 < Date.now())) {
      return redirect(res, '/index.html?login_error=bad_token', clearLogin);
    }
    const cookies = [CLEAR_LOGIN_COOKIE, makeSessionCookie({ sub: claims.sub, email: claims.email, name: claims.name || claims.given_name || '' })];
    return redirect(res, '/index.html?signed_in=1', cookies);
  } catch (err) {
    return redirect(res, '/index.html?login_error=server_error', clearLogin);
  }
}

export default async function handler(req, res) {
  if (String(req.query.state || '').startsWith('login.')) {
    return handleLogin(req, res);
  }

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

  const redirectUri = `${APP_DOMAIN}/api/auth/callback`;

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
