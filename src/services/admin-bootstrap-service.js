import { AppError } from '../errors/app-error.js';
import { Roles } from '../constants/roles.js';
import {
  AdminErrorCode,
  AdminMessageCode,
  isBootstrapAdminEmail,
} from '../constants/admin.js';

export async function grantAdminToSelf(db, userId) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, roles: true },
  });

  if (!user) {
    throw new AppError({
      httpStatus: 404,
      error: 'USER_NOT_FOUND',
      messageCode: 'resource.notFound',
      message: 'User not found.',
    });
  }

  if (!isBootstrapAdminEmail(user.email)) {
    throw new AppError({
      httpStatus: 403,
      error: AdminErrorCode.ADMIN_GRANT_NOT_ALLOWED,
      messageCode: AdminMessageCode.GRANT_NOT_ALLOWED,
      message: 'This account is not allowed to become an administrator.',
    });
  }

  const currentRoles = Array.isArray(user.roles) ? user.roles : [];
  if (currentRoles.includes(Roles.ADMIN)) {
    return { user, alreadyAdmin: true };
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { roles: { set: [...currentRoles, Roles.ADMIN] } },
    select: { id: true, email: true, roles: true, status: true },
  });

  return { user: updated, alreadyAdmin: false };
}
