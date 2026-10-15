// Saves and loads one person's synced data (tasks, events, labels, quotes, settings).
//
//   GET    /api/sync            -> the saved data and its "revision" number
//   GET    /api/sync?since=N    -> { unchanged: true } if nothing new since revision N
//   PUT    /api/sync            -> save. The page says which revision it started from (baseRev). If somebody
//                                  else (another device) saved in the meantime, you get 409 plus the newer
//                                  data, so the page can merge the two instead of overwriting.
//   DELETE /api/sync            -> deletes this person's online copy
//
// Only a signed-in person can use it, and only for their own data (it is stored under their Google id).

import { getSession } from './_lib/session.js';
import { getUserRecord, setUserRecord, deleteUserRecord, storeConfigured } from './_lib/store.js';

const MAX_BYTES = 900 * 1024; // one person's data must stay under about 900 KB

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: 'not_signed_in' });
    return;
  }
  if (!storeConfigured()) {
    res.status(503).json({ ok: false, error: 'db_not_configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const record = await getUserRecord(session.sub);
      const since = parseInt(String(req.query.since || ''), 10);
      if (record && !isNaN(since) && since === record.rev) {
        res.status(200).json({ ok: true, rev: record.rev, unchanged: true });
        return;
      }
      res.status(200).json({ ok: true, rev: record ? record.rev : 0, data: record ? record.data : null });
      return;
    }

    // Anything that changes data must carry our own header. A web page on another site can't add it,
    // so it can't trick your browser into changing your data.
    if (req.headers['x-flowgrove'] !== '1') {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body.data !== 'object' || body.data === null) {
        res.status(400).json({ ok: false, error: 'bad_data' });
        return;
      }
      if (JSON.stringify(body.data).length > MAX_BYTES) {
        res.status(413).json({ ok: false, error: 'too_big' });
        return;
      }
      const record = await getUserRecord(session.sub);
      const currentRev = record ? record.rev : 0;
      if (Number(body.baseRev) !== currentRev) {
        res.status(409).json({ ok: false, conflict: true, rev: currentRev, data: record ? record.data : null });
        return;
      }
      const next = { rev: currentRev + 1, updatedAt: Date.now(), data: body.data };
      await setUserRecord(session.sub, next);
      res.status(200).json({ ok: true, rev: next.rev });
      return;
    }

    if (req.method === 'DELETE') {
      await deleteUserRecord(session.sub);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
