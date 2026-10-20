// Returns the signed-in user's Google Calendar events, from ALL of their calendars (their own, school, family,
// holidays, shared ones, ...), for a time range. Calendars that are switched off in Google Calendar are included
// too, flagged defaultOn: false, so the page can offer them as a switch. Every page of results is read (a busy
// calendar has far more than one page), and invitations you declined are included, flagged declined: true.
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

const API_VERSION = 5;
const MAX_RANGE_MS = 70 * 24 * 60 * 60 * 1000; // never more than ~10 weeks in one request
const MAX_CALENDARS = 25;
const MAX_PAGES = 12;        // up to 12 pages of 2500 events, per calendar (far more than anyone has)

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
        .filter(function(c) { return !c.hidden; })
        .map(function(c) {
          return { id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#347CFE', primary: !!c.primary, defaultOn: !!(c.selected || c.primary) };
        })
        .sort(function(a, b) { return (b.defaultOn ? 1 : 0) - (a.defaultOn ? 1 : 0); }); // switched-on calendars first
    } else {
      // Older, narrower permission (can read events but not the list of calendars): main calendar only.
      limitedScope = true;
    }
    if (!calendars.length) calendars = [{ id: 'primary', name: 'Primary calendar', color: '#347CFE', primary: true, defaultOn: true }];
    calendars = calendars.slice(0, MAX_CALENDARS);

    // 2. Events from every one of those calendars, at the same time. A calendar answers in pages, so keep asking
    //    until there are no more pages: otherwise a busy calendar loses everything after its first page.
    const baseParams = {
      timeMin: new Date(minMs).toISOString(),
      timeMax: new Date(maxMs).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500'
    };
    async function readCalendar(cal) {
      const items = [];
      let pageToken = null;
      let truncated = false;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const params = new URLSearchParams(baseParams);
          if (pageToken) params.set('pageToken', pageToken);
          const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params.toString()}`;
          const resp = await googleGet(url, accessToken);
          if (!resp.ok) return { cal: cal, error: resp.status };
          const data = await resp.json();
          (data.items || []).forEach(function(it) { items.push(it); });
          pageToken = data.nextPageToken || null;
          if (!pageToken) break;
          if (page === MAX_PAGES - 1) truncated = true;
        }
      } catch (e) {
        return { cal: cal, error: 'network' };
      }
      return { cal: cal, items: items, truncated: truncated };
    }
    const results = await Promise.all(calendars.map(readCalendar));

    const events = [];
    const failedCalendars = [];
    const truncatedCalendars = [];
    const counts = {};
    results.forEach(function(r) {
      if (r.error) { failedCalendars.push(r.cal.name); return; }
      if (r.truncated) truncatedCalendars.push(r.cal.name);
      counts[r.cal.id] = 0;
      r.items
        .filter(function(ev) { return ev.start && (ev.start.dateTime || ev.start.date); })
        .filter(function(ev) { return ev.status !== 'cancelled' && ev.eventType !== 'workingLocation'; })
        .forEach(function(ev) {
          const me = (ev.attendees || []).find(function(a) { return a.self; });
          counts[r.cal.id]++;
          events.push({
            id: ev.id || null,
            calId: r.cal.id,
            title: ev.summary || '(No title)',
            colorId: ev.colorId || null, // an event can have its own color, different from its calendar's
            allDay: !ev.start.dateTime,
            declined: !!(me && me.responseStatus === 'declined'), // shown, but it doesn't block your time
            start: ev.start.dateTime || ev.start.date,
            end: (ev.end && (ev.end.dateTime || ev.end.date)) || ev.start.dateTime || ev.start.date
          });
        });
    });

    send({ connected: true, limitedScope: limitedScope, calendars: calendars, failedCalendars: failedCalendars, truncatedCalendars: truncatedCalendars, counts: counts, events: events });
  } catch (err) {
    send({ connected: false, events: [], calendars: [], error: 'server_error' });
  }
}
