// Tells the page who is signed in (if anyone), which Google accounts are connected, and whether syncing is
// set up on this site.

import { getSession, sessionSecretConfigured } from './_lib/session.js';
import { storeConfigured, resolveOwner, getIdentities } from './_lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getSession(req);
  const ready = storeConfigured() && sessionSecretConfigured();
  let accounts = [];
  if (session && ready) {
    try {
      const owner = await resolveOwner(session.sub);
      let list = await getIdentities(owner);
      if (!list || !list.length) list = [{ sub: owner, email: session.email, name: session.name }];
      accounts = list.map(function(x) {
        return { id: x.sub, email: x.email || '', name: x.name || '', owner: x.sub === owner, current: x.sub === session.gsub };
      });
    } catch (e) { accounts = []; }
  }
  res.status(200).json({
    ok: true,
    apiVersion: 6,
    signedIn: !!session,
    name: session ? session.name : '',
    email: session ? session.email : '',
    accounts: accounts,
    syncReady: ready
  });
}
