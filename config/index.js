const env = process.env.NODE_ENV || 'development';

const { default: defaults } = await import('./environments/default.js');
const { default: overrides } = await import(`./environments/${env}.js`);

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const config = deepMerge(defaults, { env, ...overrides });

export default config;
