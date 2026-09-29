// Handles Google's redirect back after the user approves access.
// Exchanges the authorization code for an access token + refresh token,
// then stores both in secure, HTTP-only cookies (no database needed for
// this personal-project scale). Redirects back to the app when done.
//
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET

// Must exactly match the constant in api/auth/google.js and the URI
// registered in Google Cloud Console.
const APP_DOMAIN = 'https://flowgrove.vercel.app';

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) {
    res.writeHead(302, { Location: '/index.html?calendar_error=missing_code' });
    return res.end();
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
      res.writeHead(302, { Location: '/index.html?calendar_error=token_exchange_failed' });
      return res.end();
    }

    const cookies = [];
    cookies.push(`fg_access_token=${tokenData.access_token}; HttpOnly; Secure; Path=/; Max-Age=${tokenData.expires_in || 3600}; SameSite=Lax`);
    if (tokenData.refresh_token) {
      // Refresh tokens are long-lived; only returned the first time a user
      // consents (or after revoking access), so we only overwrite it if present.
      cookies.push(`fg_refresh_token=${tokenData.refresh_token}; HttpOnly; Secure; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    cookies.push(`fg_access_token_expires=${Date.now() + ((tokenData.expires_in || 3600) * 1000)}; HttpOnly; Secure; Path=/; Max-Age=${tokenData.expires_in || 3600}; SameSite=Lax`);

    res.setHeader('Set-Cookie', cookies);
    res.writeHead(302, { Location: '/index.html?calendar_connected=1' });
    res.end();
  } catch (err) {
    res.writeHead(302, { Location: '/index.html?calendar_error=server_error' });
    res.end();
  }
}
