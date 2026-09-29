// Redirects the user to Google's OAuth consent screen.
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
// The redirect URI below must exactly match one added in Google Cloud Console
// under the OAuth Client's "Authorized redirect URIs".

// Hardcoded rather than derived from the request, since Vercel preview
// deployments each get their own unique subdomain, and only the main
// domain's callback URL is registered in Google Cloud Console.
const APP_DOMAIN = 'https://flowgrove.vercel.app';

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${APP_DOMAIN}/api/auth/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent'
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
