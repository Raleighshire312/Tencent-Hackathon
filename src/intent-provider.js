const { AdpClient } = require('./providers/adp-client');
const { offlineIntent } = require('./providers/offline-intent-provider');

function createIntentProvider({ env = process.env, adpClient } = {}) {
  const client = adpClient || new AdpClient({ appKey: env.ADP_APP_KEY, endpoint: env.ADP_ENDPOINT });
  return {
    async interpret(message, options = {}) {
      if (!client.isConfigured()) return offlineIntent(message);
      const result = await client.generateIntent({ message, ...options });
      if (!result.ok) return offlineIntent(message);
      return { ...result, note: 'ADP output must still be converted to a validated structured intent before payment preparation.' };
    },
  };
}

module.exports = { createIntentProvider };
