// Redirects the user to Google's OAuth consent screen.
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
// The redirect URI below must exactly match one added in Google Cloud Console
// under the OAuth Client's "Authorized redirect URIs".

import { randomUUID } from 'crypto';

// Hardcoded rather than derived from the request, since Vercel preview
// deployments each get their own unique subdomain, and only the main
// domain's callback URL is registered in Google Cloud Console.
const APP_DOMAIN = 'https://flowgrove.vercel.app';

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${APP_DOMAIN}/api/auth/callback`;

  // A random one-time "state" value. It is saved in a cookie here and must come back from
  // Google unchanged, which proves the sign-in was really started from this browser
  // (and not by someone else's link tricking you into connecting their calendar).
  const state = randomUUID();
  res.setHeader('Set-Cookie', `fg_oauth_state=${state}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // Read-only access to the person's calendars and events. (Flowgrove never changes your calendar.)
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
