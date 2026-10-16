'use strict';

// Map technical reason codes to plain-language strings suitable for showing
// to the user. Every code emitted by the pipeline MUST have an entry here;
// missing codes map to a generic fallback so a forgotten wiring doesn't
// silently swallow errors.

const REASONS = {
  // -- Compiler --
  NO_TRANSFER_INTENTS:        { tone: 'warn', headline: 'No explicit transfer instruction was found.', detail: 'Try phrasing the request like “Send Mum S$200 and leave at least S$500”.' },
  MULTIPLE_TRANSFER_INTENTS:  { tone: 'warn', headline: 'Multiple transfers were requested.',             detail: 'This milestone requires one transfer per request.' },
  NO_INTENTS:                 { tone: 'warn', headline: 'No transaction intents were supplied.',          detail: 'The structured AI output was empty.' },

  // -- Provider --
  ADP_NOT_CONFIGURED:         { tone: 'info', headline: 'Tencent ADP is not configured.',                   detail: 'Set ADP_APP_KEY in the environment to enable live LLM interpretation.' },
  INVALID_MESSAGE:            { tone: 'bad',  headline: 'The LLM could not be called.',                    detail: 'A non-empty string `message` is required.' },
  ADP_TIMEOUT:                { tone: 'warn', headline: 'The ADP request timed out.',                     detail: 'Live mode refused to prepare a transaction.' },
  ADP_REQUEST_FAILED:         { tone: 'warn', headline: 'The ADP request failed.',                        detail: 'Live mode refused to prepare a transaction.' },
  ADP_NETWORK_ERROR:          { tone: 'warn', headline: 'Tencent ADP could not be reached.',               detail: 'Live mode refused to prepare a transaction.' },
  ADP_HTTP_ERROR:             { tone: 'warn', headline: 'Tencent ADP rejected the request.',               detail: 'Check the published AppKey and request permissions.' },
  ADP_PROVIDER_ERROR:         { tone: 'warn', headline: 'Tencent ADP returned an error.',                  detail: 'Live mode refused to prepare a transaction.' },
  ADP_INCOMPLETE_RESPONSE:    { tone: 'warn', headline: 'Tencent ADP did not complete the response.',      detail: 'Live mode refused to prepare a transaction.' },
  ADP_RESPONSE_NOT_JSON:      { tone: 'warn', headline: 'ADP returned a response that was not JSON.',     detail: 'The structured intent contract was not satisfied.' },
  ADP_RESPONSE_TOO_LARGE:     { tone: 'warn', headline: 'ADP returned an oversized response.',           detail: 'The response exceeded the safety limit.' },
  ADP_TRANSCRIPT_HOSTILE:     { tone: 'bad',  headline: 'ADP returned hostile instructions.',             detail: 'The transcript was rejected because it contained override phrasing.' },
  ADP_REFUSED:                { tone: 'bad',  headline: 'ADP refused to interpret the request.',         detail: 'The model judged the request to be ambiguous, unsafe, or out-of-scope.' },
  ADP_TRANSCRIPT_INJECTION:   { tone: 'bad',  headline: 'ADP transcript contained injection patterns.', detail: 'Refused without executing any payment.' },
  STRUCTURE_NOT_OBJECT:       { tone: 'bad',  headline: 'ADP output was not a JSON object.',             detail: 'The structured-output contract was violated.' },
  STRUCTURE_EXTRA_FIELD:      { tone: 'bad',  headline: 'ADP returned unsupported fields.',               detail: 'The structured-output contract rejects unknown fields.' },
  STRUCTURE_REFUSAL_MISSING_REASON: { tone: 'bad', headline: 'ADP refusal had no reason.',               detail: 'The structured-output contract was violated.' },
  STRUCTURE_BAD_ACTION:       { tone: 'bad',  headline: 'The AI proposed an unsupported action.',        detail: 'Only SGD transfers are allowed by the banking contract.' },
  STRUCTURE_BAD_RECIPIENT:    { tone: 'bad',  headline: 'The AI did not return a recipient.',             detail: 'A non-empty recipient alias is required.' },
  STRUCTURE_BAD_SOURCE:       { tone: 'bad',  headline: 'The AI proposed an unsupported source account.',detail: 'Source account must be one of: spending, savings, wallet.' },
  STRUCTURE_BAD_CURRENCY:     { tone: 'bad',  headline: 'The AI proposed an unsupported currency.',       detail: 'Only SGD is supported.' },
  STRUCTURE_BAD_AMOUNT:       { tone: 'bad',  headline: 'The AI proposed an invalid amount.',             detail: 'Amount must be a positive integer in cents.' },
  STRUCTURE_BAD_MINIMUM:      { tone: 'bad',  headline: 'The AI proposed an invalid minimum balance.',    detail: 'Minimum must be a non-negative integer in cents when present.' },
  STRUCTURE_BAD_VERIFICATION: { tone: 'bad',  headline: 'The AI proposed an invalid verification flag.', detail: 'requireVerifiedRecipient must be a boolean when present.' },
  STRUCTURE_BAD_RATIONALE:    { tone: 'warn', headline: 'The AI rationale was too long.',                detail: 'Rationale must be ≤ 500 chars when present.' },

  // -- Injection guard --
  EMPTY_MESSAGE:              { tone: 'warn', headline: 'The message was empty.',                          detail: 'Refusing to interpret an empty message.' },
  USER_INJECTION_BLOCKED:     { tone: 'bad',  headline: 'The user message tried to override the rules.',  detail: 'Refused without calling the LLM.' },
  USER_MESSAGE_TOO_LONG:      { tone: 'bad',  headline: 'The user message was too long.',                 detail: 'Refused to call the LLM with a > 4,000 character prompt.' },
  USER_MESSAGE_OPAQUE:        { tone: 'bad',  headline: 'The user message contained unfamiliar characters.', detail: 'Likely an encoded payload — refused without calling the LLM.' },
  UNTRUSTED_INSTRUCTION_BLOCKED: { tone: 'bad',  headline: 'Untrusted content tried to issue instructions.',  detail: 'The invoice / external blob attempted to alter the transaction.' },

  // -- Verifier --
  SEMANTIC_MISMATCH:          { tone: 'bad',  headline: 'The AI proposal did not match the user request.',detail: 'One or more amounts, recipients, or constraints differ from the user statement.' },
  AI_INTENT_MISMATCH:         { tone: 'bad',  headline: 'The AI proposal differs from the user request.', detail: 'The proposed recipient, amount, source, currency, or balance constraint did not match the deterministic interpretation.' },
  AMOUNT_RECIPIENT_MISMATCH:  { tone: 'bad',  headline: 'An amount was paired with the wrong recipient.', detail: 'The order or pairing in the proposal does not match what the user said.' },
  RECIPIENT_NOT_IN_TEXT:      { tone: 'bad',  headline: 'A recipient was invented by the AI.',            detail: 'The recipient alias is absent from the user message.' },
  SOURCE_ACCOUNT_MISMATCH:    { tone: 'bad',  headline: 'The source account differs from what you said.', detail: 'The AI inferred a different source account than the one in your message.' },
  VERIFICATION_DOWNGRADE:     { tone: 'bad',  headline: 'The AI tried to skip recipient verification.',   detail: 'Refused to remove the verified-recipient safeguard without an explicit “any account” release phrase.' },
  MINIMUM_BALANCE:            { tone: 'bad',  headline: 'The transfer would breach the minimum balance.',detail: 'The minimum-balance constraint in your request cannot be satisfied.' },
  INSUFFICIENT_FUNDS:         { tone: 'bad',  headline: 'Insufficient funds in the source account.',      detail: 'The source account cannot cover the proposed amount.' },

  // -- Bank --
  UNSUPPORTED_ACTION:         { tone: 'bad',  headline: 'Unsupported action.',                            detail: 'Only transfers are supported.' },
  INVALID_AMOUNT:             { tone: 'bad',  headline: 'Invalid amount.',                                detail: 'Amount must be a positive integer cents value.' },
  UNSUPPORTED_CURRENCY:       { tone: 'bad',  headline: 'Unsupported currency.',                          detail: 'Only SGD is supported.' },
  SOURCE_NOT_FOUND:           { tone: 'bad',  headline: 'The source account does not exist.',             detail: 'The proposed account is not in the trust store.' },
  RECIPIENT_NOT_FOUND:        { tone: 'bad',  headline: 'The recipient is not trusted.',                  detail: 'The recipient alias does not match any verified allowlist entry.' },
  RECIPIENT_AMBIGUOUS:        { tone: 'bad',  headline: 'The recipient alias is ambiguous.',             detail: 'The alias matches more than one recipient in the allowlist.' },
  RECIPIENT_UNVERIFIED:       { tone: 'bad',  headline: 'The recipient is not verified.',                 detail: 'Only verified recipients can receive transfers.' },
  INVALID_CONSTRAINT:         { tone: 'bad',  headline: 'A constraint value is invalid.',                 detail: 'See the audit trail for the specific field.' },
  VALIDATION_FAILED:          { tone: 'bad',  headline: 'The proposal failed pre-approval validation.',   detail: 'See the violations list.' },
  INVALID_PROPOSAL:           { tone: 'bad',  headline: 'The proposal is not valid.',                     detail: 'A validated proposal is required.' },
  USER_REQUIRED:              { tone: 'bad',  headline: 'A user identity is required.',                   detail: 'Approvals must be bound to a userId.' },
  PROPOSAL_EXPIRED:           { tone: 'warn', headline: 'The proposal has expired.',                      detail: 'Re-run the prepare step to generate a new proposal.' },
  PROPOSAL_TAMPERED:          { tone: 'bad',  headline: 'The proposal was tampered with.',                detail: 'The fingerprint no longer matches the proposal contents.' },
  INVALID_APPROVAL:           { tone: 'bad',  headline: 'The approval is not valid.',                     detail: 'A pending approved payment is required.' },
  APPROVAL_EXPIRED:           { tone: 'warn', headline: 'The approval has expired.',                      detail: 'Generate a new approval.' },
  APPROVAL_TAMPERED:          { tone: 'bad',  headline: 'The approval was tampered with.',                detail: 'The approval fingerprint no longer matches its contents.' },
  ALREADY_EXECUTED:           { tone: 'warn', headline: 'The approval has already been executed.',        detail: 'Replays are rejected by construction.' },
  RECIPIENT_VERIFICATION_LOST: { tone: 'bad', headline: 'The recipient verification status changed.',     detail: 'A previously verified recipient was marked unverified before execution. Refused.' },
  AMBIGUOUS_REQUEST:          { tone: 'warn', headline: 'The instruction is ambiguous.',                  detail: 'Refused to guess; please restate the request explicitly.' },
  SESSION_MISMATCH:           { tone: 'bad',  headline: 'The approval belongs to a different session.',   detail: 'Cross-session approvals are rejected.' },
};

const DEFAULT_REASON = { tone: 'bad', headline: 'The request was refused.', detail: 'A defensive guard fired and stopped the request from advancing.' };

// Accepts an error code (string) OR a { code, reasons[] } object.
function explain(input) {
  const code = typeof input === 'string' ? input : input && input.code;
  const reasons = (input && input.reasons) || (input && input.matchedPatterns && input.matchedPatterns.map((m) => m.reason)) || [];
  const entry = (code && REASONS[code]) || DEFAULT_REASON;
  return {
    code: code || 'UNKNOWN',
    tone: entry.tone,
    headline: entry.headline,
    detail: entry.detail,
    matchedReasons: reasons.slice(0, 5),
  };
}

function explainAudit(entries) {
  return entries.map((entry) => ({
    at: entry.at,
    kind: entry.kind,
    summary: explain(entry.payload && entry.payload.code ? entry.payload : (entry.payload || {})),
    fingerprint: entry.payload && entry.payload.fingerprint ? entry.payload.fingerprint : null,
  }));
}

module.exports = { explain, explainAudit, REASONS };
