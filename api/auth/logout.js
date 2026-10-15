// Signs out: forgets who you are on this device. (Your tasks stay on this device and in your online copy.)

import { clearSessionCookie } from '../_lib/session.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-flowgrove'] !== '1') {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}
