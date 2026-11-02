// Who may read the feedback inbox. In Vercel, under Environment Variables, set ADMIN_EMAILS to the Google email
// address(es) allowed to see it, separated by commas. If it isn't set, nobody can read the inbox.

export function isAdminEmail(email) {
  const allowed = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return !!email && allowed.indexOf(String(email).toLowerCase()) !== -1;
}
