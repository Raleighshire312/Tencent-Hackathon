'use strict';

// Legacy provider: routes to ADP if configured (returns raw text), otherwise
// the offline regex provider. Kept verbatim to preserve the
// `tests/provider.test.js` contract (`result.ok === true`, `result.provider`).
const { AdpClient } = require('./providers/adp-client');
const { interpretStructuredIntent } = require('./providers/adp-structured-intent');

function createIntentProvider({ env = process.env, adpClient } = {}) {
  const client = adpClient || new AdpClient({
    appKey: env.ADP_APP_KEY,
    endpoint: env.ADP_ENDPOINT,
    timeoutMs: Number(env.ADP_TIMEOUT_MS) || 15000,
    maxResponseBytes: Number(env.ADP_MAX_RESPONSE_BYTES) || 16384,
  });
  return {
    async interpret(message, options = {}) {
      if (!client.isConfigured()) return { ok: false, provider: 'adp', code: 'ADP_NOT_CONFIGURED', message: 'ADP is not configured.' };
      const result = await client.generateIntent({ message, ...options });
      if (!result.ok) return result;
      return { ...result, note: 'ADP output must still be converted to a validated structured intent before payment preparation.' };
    },
    // Structured-output path. Returns a `{ ok, provider, mode, intent }` envelope
    // where `intent` is always a validated `{action, recipientAlias,
    // sourceAccountId, amountCents, currency, minimumRemainingCents,
    // requireVerifiedRecipient}` object — never raw text. Mode selection and
    // fail-closed behavior are enforced by interpretStructuredIntent.
    interpretStructured(message, options = {}) {
      return interpretStructuredIntent({ message, env, adpClient: client, ...options, modelName: env.ADP_MODEL || undefined });
    },
  };
}

module.exports = { createIntentProvider };
