export async function invitationHistory(all, user, timestamp = Date.now()) {
  if (user.role !== 'admin') return [];
  const rows = await all('SELECT email,role,expires_at,used_at FROM invitations WHERE organization_id=? ORDER BY expires_at DESC', user.organization_id);
  return rows.map(row => ({
    email: row.email,
    role: row.role,
    expiresAt: Number(row.expires_at),
    acceptedAt: row.used_at || null,
    status: row.used_at ? 'accepted' : Number(row.expires_at) <= timestamp ? 'expired' : 'pending'
  }));
}
