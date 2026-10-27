// Which web address the app is being used at.
//
// Google only accepts sign-in returns to addresses that are registered in Google Cloud, and Vercel gives every
// preview version its own odd address, so we never trust whatever address shows up. We only use the addresses
// listed here; anything else falls back to the first one.
//
// To use another address later: add it to this list, add it under "Domains" in Vercel, and add
//   https://<new address>/api/auth/callback
// under "Authorized redirect URIs" in Google Cloud. Only ever list addresses that YOU own.

const KNOWN = [
  'flowfillapp.vercel.app', // the main address
  'flowgrove.vercel.app'    // the old address, kept working while people move over
];
const MAIN = KNOWN[0];

export function appDomain(req) {
  const raw = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim().toLowerCase();
  return 'https://' + (KNOWN.indexOf(raw) !== -1 ? raw : MAIN);
}
