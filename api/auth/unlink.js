// Removes an added Google account. Your tasks stay with the account that owns them. You can't remove the
// account that owns the data, or the one you're signed in with right now.

import { getSession } from '../_lib/session.js';
import { storeConfigured, resolveOwner, getIdentities, setIdentities, deleteLink } from '../_lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (req.headers['x-flowgrove'] !== '1') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const session = getSession(req);
  if (!session) { res.status(401).json({ ok: false, error: 'not_signed_in' }); return; }
  if (!storeConfigured()) { res.status(503).json({ ok: false, error: 'db_not_configured' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const id = body && body.id ? String(body.id) : '';
    const owner = await resolveOwner(session.sub);
    const list = (await getIdentities(owner)) || [];
    if (!id || !list.some(function(x) { return x.sub === id; })) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    if (id === owner) { res.status(400).json({ ok: false, error: 'cannot_remove_main' }); return; }
    if (id === session.gsub) { res.status(400).json({ ok: false, error: 'cannot_remove_current' }); return; }
    await deleteLink(id);
    await setIdentities(owner, list.filter(function(x) { return x.sub !== id; }));
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
