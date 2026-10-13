// Disconnects Google Calendar: tells Google to revoke the permission, then clears
// the stored tokens. Must be called with POST (the page already does this).

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Revoking the refresh token also cancels the access tokens made from it. Without this,
  // clearing cookies would only forget the keys here; Google would still consider them valid.
  const token = readCookie(req.headers.cookie, 'fg_refresh_token') || readCookie(req.headers.cookie, 'fg_access_token');
  if (token) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: token })
      });
    } catch (e) { /* even if this fails, still clear the cookies below */ }
  }

  const expired = 'Max-Age=0; HttpOnly; Secure; Path=/; SameSite=Lax';
  res.setHeader('Set-Cookie', [
    `fg_access_token=; ${expired}`,
    `fg_refresh_token=; ${expired}`,
    `fg_access_token_expires=; ${expired}`
  ]);
  res.status(200).json({ disconnected: true });
}
