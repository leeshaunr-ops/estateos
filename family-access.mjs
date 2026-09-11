export async function lockFamily(db, organizationId, clientId) {
  await db.run('UPDATE clients SET profile=profile WHERE id=? AND organization_id=?', clientId, organizationId);
  return db.get('SELECT * FROM clients WHERE id=? AND organization_id=?', clientId, organizationId);
}

export async function linkAcceptedMember(db, invitation, userId, family) {
  if (invitation.role !== 'client' || !family) return;
  const profile = JSON.parse(family.profile || '{}');
  let changed = false;
  const members = (profile.members || []).map(member => {
    if ((member.invitationIds || []).includes(invitation.token_hash) || (member.email && member.email.toLowerCase() === invitation.email.toLowerCase())) {
      changed = true;
      return {...member, accessUserIds: [...new Set([...(member.accessUserIds || []), userId])]};
    }
    return member;
  });
  if (changed) await db.run('UPDATE clients SET profile=? WHERE id=? AND organization_id=?', JSON.stringify({...profile, members}), family.id, invitation.organization_id);
}

// Caller holds the family row lock and wraps removal and revocation in one transaction.
export async function revokeMemberAccess(db, organizationId, family, member) {
  const email = String(member.email || '').trim().toLowerCase();
  const accounts = await db.all('SELECT id,email FROM users WHERE organization_id=? AND client_id=? AND role=?', organizationId, family.id, 'client');
  let suspended = 0;
  for (const account of accounts) {
    if ((member.accessUserIds || []).includes(account.id) || (email && account.email.toLowerCase() === email)) {
      await db.run('UPDATE users SET active=0 WHERE id=? AND organization_id=? AND client_id=? AND role=?', account.id, organizationId, family.id, 'client');
      await db.run('DELETE FROM sessions WHERE user_id=?', account.id);
      suspended++;
    }
  }
  const invitations = await db.all('SELECT token_hash,email FROM invitations WHERE organization_id=? AND client_id=? AND role=? AND used_at IS NULL', organizationId, family.id, 'client');
  for (const invitation of invitations) {
    if ((member.invitationIds || []).includes(invitation.token_hash) || (email && invitation.email.toLowerCase() === email)) {
      await db.run('UPDATE invitations SET expires_at=0 WHERE token_hash=? AND organization_id=? AND used_at IS NULL', invitation.token_hash, organizationId);
    }
  }
  return suspended;
}
