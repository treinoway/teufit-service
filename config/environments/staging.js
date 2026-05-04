export default {
  auth: {
    accessTokenTtlSeconds: 60, // 1 minute
    refreshTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
  },
  rateLimit: {
        global: { max: 10000, timeWindow: '1 minute' },
        globalPerUser: { max: 10000, timeWindow: '1 minute' },
        auth: {
          waitlist: { max: 1000, timeWindow: '1 minute' },
          login: { max: 1000, timeWindow: '1 minute' },
          changePassword: { max: 1000, timeWindow: '1 minute' },
          forgotPassword: { max: 1000, timeWindow: '1 minute' },
          resetPassword: { max: 1000, timeWindow: '1 minute' },
        },
        postalCode: {
          max: 1000,
          timeWindow: '1 minute',
        },
        user: {
            getMe: {
              max: 1000,
              timeWindow: '1 minute',
            },
            updateProfile: {
              max: 1000,
              timeWindow: '1 minute',
            },
            becomeTrainer: {
              max: 1000,
              timeWindow: '1 hour',
            },
            becomeNutritionist: {
              max: 1000,
              timeWindow: '1 hour',
            },
            uploadAvatar: {
              max: 1000,
              timeWindow: '1 minute',
            },
          },
        trainer: {
          searchStudents: { max: 1000, timeWindow: '1 minute' },
        },
        trainingProtocol: {
          create: { max: 1000, timeWindow: '1 minute' },
          list: { max: 1000, timeWindow: '1 minute' },
          getById: { max: 1000, timeWindow: '1 minute' },
          update: { max: 1000, timeWindow: '1 minute' },
          delete: { max: 1000, timeWindow: '1 minute' },
          importFromTemplate: { max: 1000, timeWindow: '1 minute' },
        },
        trainingProtocolTemplate: {
          create: { max: 1000, timeWindow: '1 minute' },
          list: { max: 1000, timeWindow: '1 minute' },
          getById: { max: 1000, timeWindow: '1 minute' },
          update: { max: 1000, timeWindow: '1 minute' },
          delete: { max: 1000, timeWindow: '1 minute' },
        },
      },
};
