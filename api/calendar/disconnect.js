// Clears the stored Google tokens, effectively disconnecting Calendar sync.

export default function handler(req, res) {
  const expired = 'Max-Age=0; HttpOnly; Secure; Path=/; SameSite=Lax';
  res.setHeader('Set-Cookie', [
    `fg_access_token=; ${expired}`,
    `fg_refresh_token=; ${expired}`,
    `fg_access_token_expires=; ${expired}`
  ]);
  res.status(200).json({ disconnected: true });
}
