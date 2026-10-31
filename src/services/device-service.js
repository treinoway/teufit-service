const DEVICE_PUBLIC_SELECT = Object.freeze({ token: true, platform: true, appId: true });

/**
 * Registers a push device token for the user, moving it from any previous owner.
 *
 * @param {string} userId
 * @param {{ token: string, platform: string, appId: string }} device
 * @param {object} prismaClient
 * @returns {Promise<{ token: string, platform: string, appId: string }>}
 */
export async function registerDevice(userId, { token, platform, appId }, prismaClient) {
  const stored = await prismaClient.device.upsert({
    where: { token },
    create: { userId, token, platform, appId },
    update: { userId, platform, appId },
    select: DEVICE_PUBLIC_SELECT,
  });

  return { token: stored.token, platform: stored.platform, appId: stored.appId };
}

/**
 * Removes a push device token, only when it belongs to the given user.
 *
 * @param {string} userId
 * @param {string} token
 * @param {object} prismaClient
 * @returns {Promise<void>}
 */
export async function removeDevice(userId, token, prismaClient) {
  await prismaClient.device.deleteMany({ where: { token, userId } });
}
