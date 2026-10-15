// Starts "Sign in with Google". This only asks Google WHO you are (your name and email). It does not
// ask for your calendar; connecting Google Calendar is a separate button.
//
// Uses the same Google sign-in setup (client id and redirect address) that Calendar already uses,
// so nothing new has to be added in Google Cloud Console.

import { randomUUID } from 'crypto';

const APP_DOMAIN = 'https://flowgrove.vercel.app';

export default function handler(req, res) {
  // The "login." start tells the callback this is a sign-in, not a Calendar connection.
  const state = 'login.' + randomUUID();
  res.setHeader('Set-Cookie', `fg_login_state=${state}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`);

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
