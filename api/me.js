// Tells the page who is signed in (if anyone) and whether syncing is set up on this site.

import { getSession, sessionSecretConfigured } from './_lib/session.js';
import { storeConfigured } from './_lib/store.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getSession(req);
  res.status(200).json({
    ok: true,
    apiVersion: 5,
    signedIn: !!session,
    name: session ? session.name : '',
    email: session ? session.email : '',
    syncReady: storeConfigured() && sessionSecretConfigured()
  });
}
