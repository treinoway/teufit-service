import { describe, it, expect, vi, beforeEach } from 'vitest';

import { grantAdminToSelf } from '../../src/services/admin-bootstrap-service.js';
import { AdminErrorCode, AdminMessageCode } from '../../src/constants/admin.js';

const ALLOWED_EMAIL = 'n.santos1897@gmail.com';
const USER_ID = 'user-1';

function makeDb(initial = {}) {
  return {
    user: {
      findUnique: vi.fn(async () => initial.user ?? null),
      update: vi.fn(async ({ data }) => ({
        id: USER_ID,
        email: initial.user?.email ?? null,
        roles: data.roles?.set ?? [],
        status: 'active',
      })),
    },
  };
}

describe('grantAdminToSelf', () => {
  let db;

  beforeEach(() => {
    db = null;
  });

  it('grants admin to allowlisted user without admin role', async () => {
    db = makeDb({ user: { id: USER_ID, email: ALLOWED_EMAIL, roles: ['trainer'] } });
    const result = await grantAdminToSelf(db, USER_ID);
    expect(result.alreadyAdmin).toBe(false);
    expect(result.user.roles).toEqual(expect.arrayContaining(['trainer', 'admin']));
    expect(db.user.update).toHaveBeenCalled();
  });

  it('returns alreadyAdmin without write when user already has admin role', async () => {
    db = makeDb({ user: { id: USER_ID, email: ALLOWED_EMAIL, roles: ['admin'] } });
    const result = await grantAdminToSelf(db, USER_ID);
    expect(result.alreadyAdmin).toBe(true);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('rejects user not in allowlist with 403', async () => {
    db = makeDb({ user: { id: USER_ID, email: 'random@example.com', roles: ['trainer'] } });
    await expect(grantAdminToSelf(db, USER_ID)).rejects.toMatchObject({
      httpStatus: 403,
      error: AdminErrorCode.ADMIN_GRANT_NOT_ALLOWED,
      messageCode: AdminMessageCode.GRANT_NOT_ALLOWED,
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('handles allowlist case-insensitively and trims whitespace', async () => {
    db = makeDb({ user: { id: USER_ID, email: '  N.Santos1897@GMAIL.com  ', roles: [] } });
    const result = await grantAdminToSelf(db, USER_ID);
    expect(result.alreadyAdmin).toBe(false);
    expect(result.user.roles).toContain('admin');
  });

  it('rejects when user not found with 404', async () => {
    db = makeDb({ user: null });
    await expect(grantAdminToSelf(db, USER_ID)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});
