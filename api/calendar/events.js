// Returns the signed-in user's real Google Calendar events for a given day.
// Reads tokens from the HTTP-only cookies set by /api/auth/callback.
// If the access token has expired, uses the refresh token to get a new one
// automatically (no extra login required from the user).
//
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function(pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

async function refreshAccessToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!resp.ok) return null;
  return resp.json();
}

export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let accessToken = cookies['fg_access_token'];
  const refreshToken = cookies['fg_refresh_token'];
  const expiresAt = parseInt(cookies['fg_access_token_expires'] || '0', 10);

  if (!refreshToken && !accessToken) {
    res.status(200).json({ connected: false, events: [] });
    return;
  }

  const newCookies = [];

  if ((!accessToken || Date.now() > expiresAt - 60000) && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed && refreshed.access_token) {
      accessToken = refreshed.access_token;
      const newExpiry = Date.now() + ((refreshed.expires_in || 3600) * 1000);
      newCookies.push(`fg_access_token=${accessToken}; HttpOnly; Secure; Path=/; Max-Age=${refreshed.expires_in || 3600}; SameSite=Lax`);
      newCookies.push(`fg_access_token_expires=${newExpiry}; HttpOnly; Secure; Path=/; Max-Age=${refreshed.expires_in || 3600}; SameSite=Lax`);
    } else {
      res.status(200).json({ connected: false, events: [], needsReconnect: true });
      return;
    }
  }

  if (newCookies.length) res.setHeader('Set-Cookie', newCookies);

  const dateParam = req.query.date;
  const now = dateParam ? new Date(dateParam + 'T00:00:00') : new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  try {
    const params = new URLSearchParams({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime'
    });
    const calResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!calResp.ok) {
      res.status(200).json({ connected: false, events: [], needsReconnect: calResp.status === 401 });
      return;
    }

    const data = await calResp.json();
    const events = (data.items || [])
      .filter(function(ev) { return ev.start && (ev.start.dateTime || ev.start.date); })
      .map(function(ev) {
        const isAllDay = !ev.start.dateTime;
        return {
          title: ev.summary || '(No title)',
          allDay: isAllDay,
          start: ev.start.dateTime || ev.start.date,
          end: (ev.end && (ev.end.dateTime || ev.end.date)) || ev.start.dateTime || ev.start.date
        };
      });

    res.status(200).json({ connected: true, events: events });
  } catch (err) {
    res.status(200).json({ connected: false, events: [], error: 'server_error' });
  }
}
