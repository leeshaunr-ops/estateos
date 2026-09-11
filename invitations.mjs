export async function invitationHistory(all, user, timestamp = Date.now()) {
  if (user.role !== 'admin') return [];
  const rows = await all('SELECT token_hash,email,role,expires_at,used_at FROM invitations WHERE organization_id=? ORDER BY expires_at DESC', user.organization_id);
  return rows.map(row => ({
    id: row.token_hash,
    email: row.email,
    role: row.role,
    expiresAt: Number(row.expires_at),
    acceptedAt: row.used_at || null,
    status: row.used_at ? 'accepted' : Number(row.expires_at) === 0 ? 'cancelled' : Number(row.expires_at) <= timestamp ? 'expired' : 'pending'
  }));
}

export async function cancelInvitation(run, user, invitationId, timestamp = Date.now()) {
  if (user.role !== 'admin') return false;
  const result = await run('UPDATE invitations SET expires_at=0 WHERE token_hash=? AND organization_id=? AND used_at IS NULL AND expires_at>?', invitationId, user.organization_id, timestamp);
  return result.changes === 1;
}

export async function claimInvitation(run, invitationId, acceptedAt, timestamp = Date.now()) {
  const result = await run('UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?', acceptedAt, invitationId, timestamp);
  return result.changes === 1;
}
