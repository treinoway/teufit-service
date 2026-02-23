export default {
    rateLimit: {
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
