import { FCM_APP_NAME, MobileAppEnv } from '../constants/mobile-app.js';

/**
 * Builds a client that skips every send; used when no FCM credential is configured.
 */
function createNoopFcmClient(logger) {
  return {
    async sendToToken({ token }) {
      logger.debug({ tokenPrefix: token?.slice(0, 8) }, 'push: FCM not configured, skipping send');
      return { messageId: null };
    },
  };
}

/**
 * Parses the service account JSON from the environment; null when absent or malformed.
 */
function readServiceAccount(rawValue, logger) {
  if (!rawValue) return null;

  try {
    return JSON.parse(rawValue);
  } catch {
    logger.error(`push: ${MobileAppEnv.FCM_SERVICE_ACCOUNT} is not valid JSON, push disabled`);
    return null;
  }
}

/**
 * Builds the real FCM client on firebase-admin, loaded lazily so tests and no-op setups never import it.
 */
async function createFirebaseFcmClient(serviceAccount) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const app = initializeApp({ credential: cert(serviceAccount) }, FCM_APP_NAME);
  const messaging = getMessaging(app);

  return {
    async sendToToken({ token, notification, data }) {
      const messageId = await messaging.send({
        token,
        notification,
        data,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      return { messageId };
    },
  };
}

/**
 * Composition point for the push transport: real FCM when credentialed, otherwise a logged no-op.
 *
 * @param {{ env?: object, logger: object }} options
 * @returns {Promise<{ sendToToken: Function }>}
 */
export async function createFcmClient({ env = process.env, logger }) {
  const serviceAccount = readServiceAccount(env[MobileAppEnv.FCM_SERVICE_ACCOUNT], logger);
  if (!serviceAccount) {
    logger.warn('push: no FCM credential configured, trainer push is a no-op');
    return createNoopFcmClient(logger);
  }

  try {
    return await createFirebaseFcmClient(serviceAccount);
  } catch (error) {
    logger.error({ err: error }, 'push: FCM initialization failed, trainer push is a no-op');
    return createNoopFcmClient(logger);
  }
}
