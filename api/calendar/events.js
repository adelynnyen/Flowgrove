// Returns the signed-in user's Google Calendar events, from ALL of the calendars they have
// switched on in Google Calendar (their own, school, family, holidays, ...), for a time range.
// Reads tokens from the HTTP-only cookies set by /api/auth/callback. If the access token has
// expired, the refresh token is used to get a new one automatically.
//
// The page asks for an exact range, in the visitor's own timezone:
//   /api/calendar/events?timeMin=<ISO time>&timeMax=<ISO time>
// The server runs on UTC, so it must NOT work out "what day is it" by itself.
//
// Needs the sign-in permission "calendar.readonly" (set in api/auth/google.js). With the older,
// narrower permission only the main calendar can be read; the response then says
// limitedScope: true so the page can ask the user to reconnect.
//
// Requires these Environment Variables set in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET

const API_VERSION = 3;
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000; // never more than ~2 months in one request
const MAX_CALENDARS = 15;

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (e) { return v; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function(pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = safeDecode(val);
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

function googleGet(url, token) {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

export default async function handler(req, res) {
  // Calendar data is personal: never let a browser or CDN reuse a cached copy.
  res.setHeader('Cache-Control', 'no-store');

  const cookies = parseCookies(req.headers.cookie);
  let accessToken = cookies['fg_access_token'];
  const refreshToken = cookies['fg_refresh_token'];
  const expiresAt = parseInt(cookies['fg_access_token_expires'] || '0', 10);

  const newCookies = [];
  function send(body) {
    if (newCookies.length) res.setHeader('Set-Cookie', newCookies);
    res.status(200).json(Object.assign({ apiVersion: API_VERSION }, body));
  }

  if (!refreshToken && !accessToken) {
    send({ connected: false, events: [], calendars: [] });
    return;
  }

  // Works out the time range being asked for.
  const minMs = Date.parse(String(req.query.timeMin || ''));
  const maxMs = Date.parse(String(req.query.timeMax || ''));
  if (isNaN(minMs) || isNaN(maxMs) || maxMs <= minMs || maxMs - minMs > MAX_RANGE_MS) {
    res.status(400).json({ apiVersion: API_VERSION, connected: false, events: [], calendars: [], error: 'bad_time_range' });
    return;
  }

  let didRefresh = false;
  async function doRefresh() {
    didRefresh = true;
    const refreshed = await refreshAccessToken(refreshToken);
    if (!refreshed || !refreshed.access_token) return false;
    accessToken = refreshed.access_token;
    const lifetime = refreshed.expires_in || 3600;
    newCookies.length = 0;
    newCookies.push(`fg_access_token=${accessToken}; HttpOnly; Secure; Path=/; Max-Age=${lifetime}; SameSite=Lax`);
    newCookies.push(`fg_access_token_expires=${Date.now() + lifetime * 1000}; HttpOnly; Secure; Path=/; Max-Age=${lifetime}; SameSite=Lax`);
    return true;
  }

  if ((!accessToken || Date.now() > expiresAt - 60000) && refreshToken) {
    if (!(await doRefresh())) {
      send({ connected: false, events: [], calendars: [], needsReconnect: true });
      return;
    }
  }

  try {
    // 1. Which calendars does this person have switched on in Google Calendar?
    const listUrl = 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250';
    let listResp = await googleGet(listUrl, accessToken);
    if (listResp.status === 401 && refreshToken && !didRefresh) {
      if (await doRefresh()) listResp = await googleGet(listUrl, accessToken);
    }
    if (listResp.status === 401) {
      send({ connected: false, events: [], calendars: [], needsReconnect: true });
      return;
    }

    let calendars = [];
    let limitedScope = false;
    if (listResp.ok) {
      const listData = await listResp.json();
      calendars = (listData.items || [])
        .filter(function(c) { return c.selected || c.primary; })
        .map(function(c) {
          return { id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#347CFE', primary: !!c.primary };
        });
    } else {
      // Older, narrower permission (can read events but not the list of calendars): main calendar only.
      limitedScope = true;
    }
    if (!calendars.length) calendars = [{ id: 'primary', name: 'Primary calendar', color: '#347CFE', primary: true }];
    calendars = calendars.slice(0, MAX_CALENDARS);

    // 2. Events from every one of those calendars, at the same time.
    const params = new URLSearchParams({
      timeMin: new Date(minMs).toISOString(),
      timeMax: new Date(maxMs).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250'
    });
    const results = await Promise.all(calendars.map(async function(cal) {
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params.toString()}`;
        const resp = await googleGet(url, accessToken);
        if (!resp.ok) return { cal: cal, error: resp.status };
        const data = await resp.json();
        return { cal: cal, items: data.items || [] };
      } catch (e) {
        return { cal: cal, error: 'network' };
      }
    }));

    const events = [];
    const failedCalendars = [];
    results.forEach(function(r) {
      if (r.error) { failedCalendars.push(r.cal.name); return; }
      r.items
        .filter(function(ev) { return ev.start && (ev.start.dateTime || ev.start.date); })
        .filter(function(ev) { return ev.status !== 'cancelled' && ev.eventType !== 'workingLocation'; })
        .filter(function(ev) {
          // Skip invitations you've declined.
          const me = (ev.attendees || []).find(function(a) { return a.self; });
          return !(me && me.responseStatus === 'declined');
        })
        .forEach(function(ev) {
          events.push({
            calId: r.cal.id,
            title: ev.summary || '(No title)',
            allDay: !ev.start.dateTime,
            start: ev.start.dateTime || ev.start.date,
            end: (ev.end && (ev.end.dateTime || ev.end.date)) || ev.start.dateTime || ev.start.date
          });
        });
    });

    send({ connected: true, limitedScope: limitedScope, calendars: calendars, failedCalendars: failedCalendars, events: events });
  } catch (err) {
    send({ connected: false, events: [], calendars: [], error: 'server_error' });
  }
}
