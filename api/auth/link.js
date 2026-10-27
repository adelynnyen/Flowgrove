// Starts "Add another Google account". You must already be signed in. Google asks you to pick the OTHER
// account, and when you do, the callback connects it to the one you're signed in with.

import { randomUUID } from 'crypto';
import { getSession } from '../_lib/session.js';
import { appDomain } from '../_lib/app.js';


export default function handler(req, res) {
  const APP_DOMAIN = appDomain(req);
  if (!getSession(req)) {
    res.writeHead(302, { Location: '/index.html?link_error=not_signed_in' });
    res.end();
    return;
  }
  const state = 'link.' + randomUUID();
  res.setHeader('Set-Cookie', `fg_link_state=${state}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_DOMAIN}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    prompt: 'select_account'
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
