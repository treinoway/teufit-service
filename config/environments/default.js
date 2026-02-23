export default {
  auth: {
    accessTokenTtlSeconds: 60 * 15, // 15 minutes
    refreshTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
  },
  rateLimit: {
    postalCode: {
      max: 10,
      timeWindow: '1 minute',
    },
    user: {
      getMe: {
        max: 30,
        timeWindow: '1 minute',
      },
      updateProfile: {
        max: 10,
        timeWindow: '1 minute',
      },
      becomeTrainer: {
        max: 3,
        timeWindow: '1 hour',
      },
      uploadAvatar: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    trainer: {
      searchStudents: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
    trainingProtocol: {
      create: {
        max: 20,
        timeWindow: '1 minute',
      },
      list: {
        max: 60,
        timeWindow: '1 minute',
      },
      getById: {
        max: 60,
        timeWindow: '1 minute',
      },
      update: {
        max: 20,
        timeWindow: '1 minute',
      },
      delete: {
        max: 10,
        timeWindow: '1 minute',
      },
      importFromTemplate: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    trainingProtocolTemplate: {
      create: {
        max: 20,
        timeWindow: '1 minute',
      },
      list: {
        max: 60,
        timeWindow: '1 minute',
      },
      getById: {
        max: 60,
        timeWindow: '1 minute',
      },
      update: {
        max: 20,
        timeWindow: '1 minute',
      },
      delete: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  },
};
