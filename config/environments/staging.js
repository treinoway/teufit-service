export default {
  auth: {
    exposeResetTokenInResponse: false,
    accessTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
    refreshTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
  },
  rateLimit: {
        global: { max: 10000, timeWindow: '1 minute' },
        globalPerUser: { max: 10000, timeWindow: '1 minute' },
        auth: {
          waitlist: { max: 1000, timeWindow: '1 minute' },
          login: { max: 1000, timeWindow: '1 minute' },
          loginPerEmail: { max: 1000, timeWindow: '1 minute' },
          changePassword: { max: 1000, timeWindow: '1 minute' },
          forgotPassword: { max: 1000, timeWindow: '1 minute' },
          forgotPasswordPerEmail: { max: 1000, timeWindow: '1 minute' },
          resetPassword: { max: 1000, timeWindow: '1 minute' },
          verifyEmail: { max: 1000, timeWindow: '1 minute' },
          resendEmailVerification: { max: 1000, timeWindow: '1 minute' },
          signup: { max: 1000, timeWindow: '1 minute' },
          signupDirect: { max: 1000, timeWindow: '1 minute' },
          signupVerify: { max: 1000, timeWindow: '1 minute' },
          signupVerifyPerEmail: { max: 1000, timeWindow: '1 minute' },
          signupResend: { max: 1000, timeWindow: '1 minute' },
          signupInvite: { max: 1000, timeWindow: '1 minute' },
        },
        postalCode: {
          max: 1000,
          timeWindow: '1 minute',
        },
        invite: {
          preview: {
            max: 1000,
            timeWindow: '1 minute',
          },
        },
        user: {
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
            redeemInvite: {
              max: 1000,
              timeWindow: '1 hour',
            },
            deleteAccount: {
              max: 1000,
              timeWindow: '1 hour',
            },
          },
        trainer: {
          inviteStudent: { max: 1000, timeWindow: '1 minute' },
          resendStudentInvite: { max: 1000, timeWindow: '1 minute' },
        },
        nutritionist: {
          invitePatient: { max: 1000, timeWindow: '1 minute' },
          resendPatientInvite: { max: 1000, timeWindow: '1 minute' },
        },
      },
};
