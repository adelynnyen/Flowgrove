// The feedback form. Anyone can SEND feedback (a bug, a suggestion, or both, with a picture of the screen).
// Only the people listed in the ADMIN_EMAILS setting in Vercel can READ it.
//
//   POST   /api/feedback            -> send feedback (anyone)
//   GET    /api/feedback?list=1     -> the latest feedback, without pictures (admin)
//   GET    /api/feedback?id=...     -> one piece of feedback, with its picture (admin)
//   DELETE /api/feedback?id=...     -> delete one (admin)
//
// Email: when feedback arrives, an email can be sent to you (with the picture attached). That uses a free
// service called Resend. In Vercel, under Environment Variables, set:
//   RESEND_API_KEY   the key you create on resend.com (it starts with re_)
//   NOTIFY_EMAILS    the email address(es) to notify, separated by commas. On Resend's free plan without your own
//                    domain, this must be the same address you signed up to Resend with. (If it is not set,
//                    ADMIN_EMAILS is used.)
//   FEEDBACK_FROM    optional. The "from" address. Only needed once you have verified your own domain on Resend.
// If these are not set, nothing is emailed; the feedback is still saved and shows up in the Feedback inbox.

import { getSession } from './_lib/session.js';
import { storeConfigured, rawCommand } from './_lib/store.js';
import { isAdminEmail } from './_lib/admin.js';

const KINDS = ['Bug', 'Suggestion', 'Both'];
const ROLES = ['Working adult', 'College student', 'High school student', 'Middle school student', 'Elementary student', 'Other'];
const MAX_MESSAGE = 4000;
const MAX_IMAGE_CHARS = 700 * 1024;   // the picture, as text (a screen picture is usually 100-250 KB)
const KEEP = 300;                      // only the newest 300 are kept
const MAX_PER_HOUR = 8;                // per person (address), so nobody can flood the inbox

const clip = function(s, n) { return String(s == null ? '' : s).slice(0, n); };

// Sends the "you have new feedback" email, with everything the person filled in. It never makes sending feedback fail: any
// problem is ignored, but what happened is written down (and shown in the Feedback inbox) so you can see why an email did not arrive.
async function notifyByEmail(item, image) {
  try {
    const key = process.env.RESEND_API_KEY;
    const to = String(process.env.NOTIFY_EMAILS || process.env.ADMIN_EMAILS || '').split(/[,\s]+/).filter(Boolean);
    if (!key) return 'not set up (add RESEND_API_KEY in Vercel)';
    if (!to.length) return 'not set up (add NOTIFY_EMAILS in Vercel)';
    const role = item.role === 'Other' ? 'Other: ' + (item.roleOther || '(nothing typed)') : (item.role || '(not chosen)');
    const oneLine = item.message.replace(/[\r\n\t]+/g, ' ').slice(0, 70);
    let when = new Date(item.createdAt).toISOString();
    try { when = new Date(item.createdAt).toLocaleString('en-US', { timeZone: process.env.FEEDBACK_TZ || 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }); } catch (e) {}
    const payload = {
      from: process.env.FEEDBACK_FROM || 'Flowfill <onboarding@resend.dev>',
      to: to,
      subject: 'Flowfill ' + item.kind.toLowerCase() + ': ' + oneLine,
      text: ['New feedback from Flowfill', '',
        'What is it?   ' + item.kind,
        'Role:         ' + role,
        'Sent:         ' + when,
        'Picture:      ' + (image ? 'attached to this email' : 'none was sent'), '',
        'What they wrote:', '', item.message, '',
        '-----',
        'Signed in: ' + (item.signedIn ? 'yes' : 'no'), 'Screen: ' + (item.screen || '?'), 'Browser: ' + (item.browser || '?'),
        'You can also read it, and delete it, in Flowfill: Settings > Feedback inbox.'].join('\n')
    };
    if (image) {
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(image);
      if (m) payload.attachments = [{ filename: 'their-screen.' + (m[1] === 'jpeg' ? 'jpg' : m[1]), content: m[2] }];
    }
    const ctl = new AbortController();
    const timer = setTimeout(function() { ctl.abort(); }, 7000);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    clearTimeout(timer);
    if (resp.ok) return 'sent to ' + to.join(', ');
    let why = ''; try { const j = await resp.json(); why = j && (j.message || j.error || j.name) || ''; } catch (e) {}
    return 'failed (' + resp.status + ')' + (why ? ': ' + String(why).slice(0, 180) : '');
  } catch (e) { return 'failed: ' + String(e && e.message || e).slice(0, 120); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeConfigured()) { res.status(503).json({ ok: false, error: 'db_not_configured' }); return; }

  try {
    if (req.method === 'POST') {
      if (req.headers['x-flowgrove'] !== '1') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object') { res.status(400).json({ ok: false, error: 'bad_data' }); return; }

      const message = clip(body.message, MAX_MESSAGE).trim();
      if (message.length < 2) { res.status(400).json({ ok: false, error: 'empty' }); return; }
      const kind = KINDS.indexOf(body.kind) !== -1 ? body.kind : 'Bug';
      const role = ROLES.indexOf(body.role) !== -1 ? body.role : '';
      const roleOther = role === 'Other' ? clip(body.roleOther, 120).trim() : '';
      let image = null;
      if (body.image) {
        const img = String(body.image);
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) { res.status(400).json({ ok: false, error: 'bad_image' }); return; }
        if (img.length > MAX_IMAGE_CHARS) { res.status(413).json({ ok: false, error: 'image_too_big' }); return; }
        image = img;
      }

      // a gentle limit per person
      const ip = clip((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', 60);
      const rateKey = 'fg:fbrate:' + ip;
      const n = await rawCommand(['INCR', rateKey]);
      if (n === 1) await rawCommand(['EXPIRE', rateKey, 3600]);
      if (n > MAX_PER_HOUR) { res.status(429).json({ ok: false, error: 'too_many' }); return; }

      const session = getSession(req);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const item = {
        id: id, createdAt: Date.now(), kind: kind, message: message, role: role, roleOther: roleOther,
        hasImage: !!image, signedIn: !!session,
        screen: clip(body.screen, 20), browser: clip(body.browser || req.headers['user-agent'], 160)
      };
      item.email = await notifyByEmail(item, image);        // (what happened with the email alert is saved with the feedback)
      await rawCommand(['SET', 'fg:fb:' + id, JSON.stringify(item)]);
      if (image) await rawCommand(['SET', 'fg:fbimg:' + id, image]);
      await rawCommand(['LPUSH', 'fg:fb:list', id]);
      const dropped = await rawCommand(['LRANGE', 'fg:fb:list', String(KEEP), '-1']);
      if (Array.isArray(dropped) && dropped.length) {
        await rawCommand(['LTRIM', 'fg:fb:list', '0', String(KEEP - 1)]);
        for (let i = 0; i < dropped.length; i++) { await rawCommand(['DEL', 'fg:fb:' + dropped[i], 'fg:fbimg:' + dropped[i]]); }
      }
      res.status(200).json({ ok: true });
      return;
    }

    // everything below is for the admin only
    const session = getSession(req);
    if (!session || !isAdminEmail(session.email)) { res.status(403).json({ ok: false, error: 'not_admin' }); return; }

    if (req.method === 'GET') {
      if (req.query.id) {
        const id = clip(req.query.id, 40).replace(/[^a-z0-9]/gi, '');
        const raw = await rawCommand(['GET', 'fg:fb:' + id]);
        if (!raw) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        const item = JSON.parse(raw);
        item.image = item.hasImage ? await rawCommand(['GET', 'fg:fbimg:' + id]) : null;
        res.status(200).json({ ok: true, item: item });
        return;
      }
      const ids = await rawCommand(['LRANGE', 'fg:fb:list', '0', '99']);
      let items = [];
      if (Array.isArray(ids) && ids.length) {
        const raws = await rawCommand(['MGET'].concat(ids.map(function(i) { return 'fg:fb:' + i; })));
        items = (raws || []).map(function(r) { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
      }
      res.status(200).json({ ok: true, items: items });
      return;
    }

    if (req.method === 'DELETE') {
      if (req.headers['x-flowgrove'] !== '1') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const id = clip(req.query.id, 40).replace(/[^a-z0-9]/gi, '');
      if (!id) { res.status(400).json({ ok: false, error: 'no_id' }); return; }
      await rawCommand(['DEL', 'fg:fb:' + id, 'fg:fbimg:' + id]);
      await rawCommand(['LREM', 'fg:fb:list', '0', id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
