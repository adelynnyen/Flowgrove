// Talks to the online database (Upstash Redis, which you connect in Vercel under Storage).
// Vercel fills in the connection settings for you. Depending on how the database was added, they are named
// KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Both work here.
//
// Each person gets ONE entry, named after their Google id, that holds all of their synced data.

function connection() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return (url && token) ? { url: url, token: token } : null;
}

export function storeConfigured() {
  return !!connection();
}

async function run(command) {
  const c = connection();
  if (!c) throw new Error('db_not_configured');
  const resp = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const json = await resp.json();
  if (!resp.ok || json.error) throw new Error(json.error || ('db_error_' + resp.status));
  return json.result;
}

function keyFor(sub) { return 'fg:user:' + sub; }

export async function getUserRecord(sub) {
  const raw = await run(['GET', keyFor(sub)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function setUserRecord(sub, record) {
  await run(['SET', keyFor(sub), JSON.stringify(record)]);
}

export async function deleteUserRecord(sub) {
  await run(['DEL', keyFor(sub)]);
}

// ----- Several Google accounts, one set of data -----
// A person can add a second Google account (say home and school). The first account owns the data. Each added
// account gets a "link" that points to the owner, so signing in with either one opens the same data.
//   fg:link:<google id>   -> the owner's id          (only for added accounts)
//   fg:ids:<owner id>     -> the list of Google accounts that open this data (id, email, name)

export async function resolveOwner(sub) {
  const owner = await run(['GET', 'fg:link:' + sub]);
  return owner || sub;
}
export async function setLink(sub, owner) { await run(['SET', 'fg:link:' + sub, owner]); }
export async function deleteLink(sub) { await run(['DEL', 'fg:link:' + sub]); }

export async function getIdentities(owner) {
  const raw = await run(['GET', 'fg:ids:' + owner]);
  if (!raw) return null;
  try { const list = JSON.parse(raw); return Array.isArray(list) ? list : null; } catch (e) { return null; }
}
export async function setIdentities(owner, list) { await run(['SET', 'fg:ids:' + owner, JSON.stringify(list)]); }
export async function deleteIdentities(owner) { await run(['DEL', 'fg:ids:' + owner]); }
