export default {
  rateLimit: {
    global: { max: 1000, timeWindow: "1 minute" },
    globalPerUser: { max: 300, timeWindow: "1 minute" },
  },
};
