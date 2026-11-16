// Visibility and the data endpoint must use the same server-owned allowlist.
export function isAdminUid(user, env) {
  return typeof user?.uid === 'string' && user.uid !== '' &&
    (env.ADMIN_UIDS || '').split(',').map(uid => uid.trim()).filter(Boolean).includes(user.uid);
}

export function canAccessAdmin(user, account, env) {
  return isAdminUid(user, env) && account?.termsAccepted === true && account?.profileComplete === true;
}
