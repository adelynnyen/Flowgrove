// Redirects the user to Google's OAuth consent screen.
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
// The redirect URI below must exactly match one added in Google Cloud Console
// under the OAuth Client's "Authorized redirect URIs".

import { randomUUID } from 'crypto';
import { appDomain } from '../_lib/app.js';

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${appDomain(req)}/api/auth/callback`; // only addresses registered in Google Cloud are ever used

  // A random one-time "state" value. It is saved in a cookie here and must come back from
  // Google unchanged, which proves the sign-in was really started from this browser
  // (and not by someone else's link tricking you into connecting their calendar).
  const state = randomUUID();
  res.setHeader('Set-Cookie', `fg_oauth_state=${state}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // Read-only access to the person's calendars and events. (Flowfill never changes your calendar.)
    // Reading ALL of someone's calendars (school, family, ...) needs this one; the older
    // calendar.events permission only allows the main calendar.
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
