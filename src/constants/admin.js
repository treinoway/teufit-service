export const BOOTSTRAP_ADMIN_EMAILS = Object.freeze([
  'n.santos1897@gmail.com',
]);

export const AdminErrorCode = Object.freeze({
  ADMIN_GRANT_NOT_ALLOWED: 'ADMIN_GRANT_NOT_ALLOWED',
});

export const AdminMessageCode = Object.freeze({
  GRANT_NOT_ALLOWED: 'admin.grantNotAllowed',
});

export function isBootstrapAdminEmail(email) {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  return BOOTSTRAP_ADMIN_EMAILS.some((allowed) => allowed.toLowerCase() === normalized);
}
