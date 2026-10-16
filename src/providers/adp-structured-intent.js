'use strict';

const { AdpClient, extractFirstJsonObject } = require('./adp-client');
const { offlineIntent } = require('./offline-intent-provider');
const { CONTRACT_VERSION, SYSTEM_PROMPT, RESPONSE_FORMAT } = require('./intent-contract');

// ---------------------------------------------------------------------------
// JSON Schema for a structured transaction intent. Kept hand-written and
// intentionally minimal to avoid adding a JSON-Schema dependency. The
// validator below mirrors this schema 1:1.
// ---------------------------------------------------------------------------

const SUPPORTED_ACTIONS  = ['transfer'];
const SUPPORTED_CURRENCIES = ['SGD'];
const SUPPORTED_SOURCE_ACCOUNTS = ['spending', 'savings', 'wallet'];
const MAX_RATIONALE_LEN = 500;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MODES = Object.freeze({ LIVE: 'LIVE', OFFLINE_DEMO: 'OFFLINE_DEMO' });

const STRUCTURED_RESPONSE_FORMAT = RESPONSE_FORMAT;

// --- Tiny schema validator ---------------------------------------------------
// Returns {ok:true, value} on success, or {ok:false, code, message, fieldPath}.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(code, message, fieldPath = null) {
  return { ok: false, code, message, fieldPath };
}

function validateStructuredIntent(value) {
  if (!isPlainObject(value)) return fail('STRUCTURE_NOT_OBJECT', 'Top-level value must be an object.', '$');

  // Refusal branch
  if (value.refusal === true) {
    if (Object.keys(value).some((key) => !['refusal', 'reason'].includes(key))) return fail('STRUCTURE_EXTRA_FIELD', 'Refusal objects may contain only refusal and reason.', '$');
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      return fail('STRUCTURE_REFUSAL_MISSING_REASON', 'A refusal must include a string reason.', '$.reason');
    }
    return { ok: true, refusal: true, reason: value.reason };
  }

  const allowed = new Set(['action', 'recipientAlias', 'sourceAccountId', 'amountCents', 'currency', 'minimumRemainingCents', 'requireVerifiedRecipient', 'rationale']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail('STRUCTURE_EXTRA_FIELD', 'Structured intents may not contain unknown fields.', '$');

  if (typeof value.action !== 'string' || !SUPPORTED_ACTIONS.includes(value.action)) {
    return fail('STRUCTURE_BAD_ACTION', `action must be one of ${SUPPORTED_ACTIONS.join(', ')}.`, '$.action');
  }
  if (typeof value.recipientAlias !== 'string' || value.recipientAlias.length === 0 || value.recipientAlias.length > 64) {
    return fail('STRUCTURE_BAD_RECIPIENT', 'recipientAlias must be a non-empty string ≤ 64 chars.', '$.recipientAlias');
  }
  if (typeof value.sourceAccountId !== 'string' || !SUPPORTED_SOURCE_ACCOUNTS.includes(value.sourceAccountId)) {
    return fail('STRUCTURE_BAD_SOURCE', `sourceAccountId must be one of ${SUPPORTED_SOURCE_ACCOUNTS.join(', ')}.`, '$.sourceAccountId');
  }
  if (typeof value.currency !== 'string' || !SUPPORTED_CURRENCIES.includes(value.currency)) {
    return fail('STRUCTURE_BAD_CURRENCY', `currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}.`, '$.currency');
  }
  if (!Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 || value.amountCents > 1000000000) {
    return fail('STRUCTURE_BAD_AMOUNT', 'amountCents must be a positive integer ≤ 1_000_000_000.', '$.amountCents');
  }
  if (value.minimumRemainingCents !== undefined) {
    if (!Number.isSafeInteger(value.minimumRemainingCents) || value.minimumRemainingCents < 0) {
      return fail('STRUCTURE_BAD_MINIMUM', 'minimumRemainingCents must be a non-negative integer when present.', '$.minimumRemainingCents');
    }
  }
  if (value.requireVerifiedRecipient !== undefined && typeof value.requireVerifiedRecipient !== 'boolean') {
    return fail('STRUCTURE_BAD_VERIFICATION', 'requireVerifiedRecipient must be a boolean when present.', '$.requireVerifiedRecipient');
  }
  if (value.rationale !== undefined) {
    if (typeof value.rationale !== 'string' || value.rationale.length > MAX_RATIONALE_LEN) {
      return fail('STRUCTURE_BAD_RATIONALE', `rationale must be a string ≤ ${MAX_RATIONALE_LEN} chars when present.`, '$.rationale');
    }
  }

  // Normalise: ensure defaults so consumers don't have to guess.
  return {
    ok: true,
    intent: {
      action: 'transfer',
      recipientAlias: value.recipientAlias,
      sourceAccountId: value.sourceAccountId,
      amountCents: value.amountCents,
      currency: value.currency,
      minimumRemainingCents: Number.isInteger(value.minimumRemainingCents) ? value.minimumRemainingCents : 0,
      // Recipient verification is an application policy, not an AI choice.
      requireVerifiedRecipient: true,
      rationale: typeof value.rationale === 'string' ? value.rationale : '',
    },
  };
}

// Detect anything in the response that smells like a prompt-injection or
// an instruction-override attempt. We treat this as transcript tampering
// even if the JSON object itself parses cleanly.
function transcriptLooksHostile(text) {
  const t = String(text || '');
  return /(ignore\s+(?:all\s+)?previous)|forget\s+(?:all\s+)?(?:prior|above)|system\s*prompt|you\s+are\s+now|<\|im_start\|>|<\/?system>|###\s*system|act\s+as\s+(?:a|an|unrestricted|new)/i.test(t);
}

// --- Public factory ----------------------------------------------------------

function interpretStructuredIntent({
  message,
  visitorId,
  conversationId,
  env = process.env,
  adpClient,
  mode = env.INTENTLOCK_MODE || (adpClient ? MODES.LIVE : MODES.OFFLINE_DEMO),
  modelName,
  now = Date.now,
} = {}) {
  const client = adpClient || new AdpClient({ appKey: env.ADP_APP_KEY, endpoint: env.ADP_ENDPOINT });
  const offlineResult = (reasonCode) => {
    const off = offlineIntent(message);
    if (!off.ok) {
      return {
        ok: false,
        provider: 'offline',
        code: reasonCode || off.code,
        message: off.message || 'Offline provider could not parse the request.',
      };
    }
    return {
      ok: true,
      provider: 'offline',
      mode: MODES.OFFLINE_DEMO,
      intent: off.intent,
      rationale: 'Offline demo mode uses deterministic local parsing; no live AI request was made.',
      rawText: off.rawText,
      adpError: reasonCode || null,
    };
  };

  return (async () => {
    if (!Object.values(MODES).includes(mode)) {
      return { ok: false, provider: 'system', code: 'INVALID_MODE', message: `INTENTLOCK_MODE must be LIVE or OFFLINE_DEMO.` };
    }
    if (mode === MODES.OFFLINE_DEMO) return offlineResult('OFFLINE_DEMO_MODE');
    if (!client.isConfigured()) return { ok: false, provider: 'adp', mode, code: 'ADP_NOT_CONFIGURED', message: 'LIVE mode requires a configured Tencent ADP client.' };
    if (typeof message !== 'string' || !message.trim()) {
      return { ok: false, provider: 'adp', code: 'INVALID_MESSAGE', message: 'A non-empty string `message` is required.' };
    }

    const adpRes = await client.generateIntent({
      message,
      visitorId: visitorId || env.ADP_VISITOR_ID || 'intentlock-demo-user',
      conversationId,
      systemPrompt: SYSTEM_PROMPT,
      schema: STRUCTURED_RESPONSE_FORMAT,
      responseFormat: 'json_object',
      modelName,
    });
    if (!adpRes.ok) {
      return {
        ok: false,
        provider: 'adp',
        mode,
        code: adpRes.code,
        message: adpRes.message,
        providerErrorCode: adpRes.providerErrorCode || null,
        httpStatus: adpRes.httpStatus || null,
        requestId: adpRes.requestId || null,
        latencyMs: adpRes.latencyMs || null,
      };
    }

    if (adpRes.bytes && adpRes.bytes > client.maxResponseBytes) {
      return { ok: false, provider: 'adp', mode, code: 'ADP_RESPONSE_TOO_LARGE', message: 'ADP response exceeded the configured safety limit.' };
    }
    if (transcriptLooksHostile(adpRes.text)) {
      return { ok: false, provider: 'adp', mode, code: 'ADP_TRANSCRIPT_HOSTILE', message: 'ADP response contained an instruction-override pattern.' };
    }

    const candidate = extractFirstJsonObject(adpRes.text);
    if (!candidate) return { ok: false, provider: 'adp', mode, code: 'ADP_RESPONSE_NOT_JSON', message: 'ADP did not return a structured JSON intent.' };

    let parsed;
    try { parsed = JSON.parse(candidate); } catch { return { ok: false, provider: 'adp', mode, code: 'ADP_RESPONSE_NOT_JSON', message: 'ADP returned malformed JSON.' }; }

    const validation = validateStructuredIntent(parsed);
    if (!validation.ok) return { ok: false, provider: 'adp', mode, code: validation.code, message: validation.message, fieldPath: validation.fieldPath };
    if (validation.refusal) {
      return { ok: false, provider: 'adp', mode, code: 'ADP_REFUSED', message: `ADP refused: ${validation.reason}`, refusal: true, reason: validation.reason };
    }

    return {
      ok: true,
      provider: 'adp',
      mode,
      intent: { ...validation.intent, ttlMs: DEFAULT_TTL_MS },
      contractVersion: CONTRACT_VERSION,
      requestId: adpRes.requestId || null,
      latencyMs: adpRes.latencyMs || null,
      completed: adpRes.completed === true,
      rationale: validation.intent.rationale,
      raw: adpRes.text,
      bytes: adpRes.bytes,
      at: now(),
    };
  })();
}

module.exports = {
  interpretStructuredIntent,
  validateStructuredIntent,
  transcriptLooksHostile,
  SYSTEM_PROMPT,
  STRUCTURED_RESPONSE_FORMAT,
  MODES,
  SUPPORTED_ACTIONS,
  SUPPORTED_CURRENCIES,
  SUPPORTED_SOURCE_ACCOUNTS,
};
