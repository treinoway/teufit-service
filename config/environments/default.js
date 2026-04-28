export default {
  auth: {
    accessTokenTtlSeconds: 60 * 15, // 15 minutes
    refreshTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
  },
  rateLimit: {
    global: {
      max: 100,
      timeWindow: '1 minute',
    },
    globalPerUser: {
      max: 20,
      timeWindow: '1 minute',
    },
    auth: {
      waitlist: {
        max: 3,
        timeWindow: '1 hour',
      },
      login: {
        max: 5,
        timeWindow: '1 minute',
      },
      changePassword: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
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
      becomeNutritionist: {
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
    import: {
      primecoachingPreview: {
        max: 3,
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
    dietProtocol: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      delete: { max: 10, timeWindow: '1 minute' },
      importFromTemplate: { max: 10, timeWindow: '1 minute' },
    },
    dietProtocolTemplate: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      delete: { max: 10, timeWindow: '1 minute' },
    },
    nutritionistPatient: {
      link: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      unlink: { max: 10, timeWindow: '1 minute' },
      metabolicProfile: { max: 20, timeWindow: '1 minute' },
    },
    food: {
      search: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      groups: { max: 60, timeWindow: '1 minute' },
    },
    dietMeal: {
      create: { max: 30, timeWindow: '1 minute' },
      update: { max: 30, timeWindow: '1 minute' },
      delete: { max: 20, timeWindow: '1 minute' },
    },
    dietFoodItem: {
      create: { max: 30, timeWindow: '1 minute' },
      update: { max: 30, timeWindow: '1 minute' },
      delete: { max: 20, timeWindow: '1 minute' },
    },
  },
};
