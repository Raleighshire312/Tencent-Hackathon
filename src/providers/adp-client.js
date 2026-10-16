'use strict';

const crypto = require('node:crypto');
const DEFAULT_ENDPOINT = 'https://wss.lke.tencentcloud.com/adp/v2/chat';

function parseDataLine(data) {
  if (data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data);
    return parsed.answer ?? parsed.content ?? parsed.text ?? parsed.data?.answer ?? parsed.data?.content ?? '';
  } catch {
    return data;
  }
}

async function readSseText(response) {
  if (!response.ok) throw new Error(`ADP request failed with HTTP ${response.status}`);
  const body = await response.text();
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => parseDataLine(line.slice(5).trim()))
    .join('');
}

function parseSseTranscript(body) {
  const events = [];
  let eventName = '';
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    let parsed = null;
    try { parsed = JSON.parse(data); } catch { /* preserve malformed event for diagnostics */ }
    events.push({ event: eventName, data, parsed });
    eventName = '';
    dataLines = [];
  };
  for (const line of String(body || '').split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (!line.trim()) flush();
  }
  flush();
  let text = '';
  let completed = false;
  let requestId = null;
  let error = null;
  let errorCode = null;
  for (const item of events) {
    const p = item.parsed;
    if (!p) continue;
    requestId ||= p.RequestId || p.Response?.ExtraInfo?.RequestId || p.Error?.RequestId || null;
    const type = p.Type || item.event;
    if (type === 'text.replace') text = typeof p.Text === 'string' ? p.Text : text;
    else if (type === 'text.delta') text += typeof p.Text === 'string' ? p.Text : '';
    else if (type === 'response.completed') {
      completed = p.Response?.Status === 'success';
      if (!completed) error = p.Response?.StatusDesc || 'ADP response did not complete successfully.';
      const finalText = p.Response?.Messages?.flatMap((m) => m.Contents || []).find((c) => c.Type === 'text')?.Text;
      if (!text && finalText) text = finalText;
    } else if (type === 'error') { error = p.Error?.Message || 'ADP returned an error event.'; errorCode = p.Error?.Code || null; }
  }
  return { events, text, completed, requestId, error, errorCode };
}

// Pull the first JSON object embedded anywhere in the response. ADP streams
// incremental fragments; the model is responsible for emitting the closing
// brace. We tolerate whitespace, code fences, and prose around the JSON.
function extractFirstJsonObject(text) {
  const stringified = String(text || '');
  // Strip code fences.
  const stripped = stringified.replace(/```[\s\S]*?```/g, '').replace(/`+/g, '');
  // Find the first balanced top-level JSON object.
  for (let start = 0; start < stripped.length; start += 1) {
    if (stripped[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return stripped.slice(start, i + 1);
      }
    }
  }
  return '';
}

class AdpClient {
  constructor({
    appKey,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    maxResponseBytes = 16384,
    clock = () => Date.now(),
  } = {}) {
    this.appKey = appKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.clock = clock;
  }

  isConfigured() { return Boolean(this.appKey && this.fetchImpl); }

  // Build the request body. Existing callers that don't pass `systemPrompt` /
  // `schema` / `response_format` continue to send the original shape — this
  // keeps the SSE transport test in provider.test.js green.
  _buildBody({ message, visitorId, userId, conversationId, systemPrompt, modelName }) {
    const body = {
      RequestId: crypto.randomUUID(),
      ConversationId: conversationId || crypto.randomUUID(),
      AppKey: this.appKey,
      VisitorId: visitorId,
      UserId: userId || visitorId,
      Contents: [{ Type: 'text', Text: message }],
      Incremental: true,
      EnableMultiIntent: true,
      Stream: 'enable',
    };
    if (systemPrompt) body.SystemRole = systemPrompt;
    if (modelName) body.ModelName = modelName;
    return body;
  }

  // Existing transport (kept for the legacy text pipeline + tests). Returns
  // the concatenated SSE transcript. All ADP-key leakage is already scrubbed
  // by readSseText.
  async generateIntent({
    message, visitorId = 'intentlock-demo-user', userId, conversationId, systemPrompt, modelName,
  } = {}) {
    if (!this.isConfigured()) {
      return { ok: false, provider: 'adp', code: 'ADP_NOT_CONFIGURED', message: 'ADP is not configured; use the offline provider.' };
    }
    if (!message || typeof message !== 'string') {
      return { ok: false, provider: 'adp', code: 'INVALID_MESSAGE', message: 'A text message is required.' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const requestStartedAt = this.clock();
      const requestBody = this._buildBody({ message, visitorId, userId, conversationId, systemPrompt, modelName });
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        redirect: 'error',
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (response.redirected) throw new Error('ADP redirect refused.');
      if (!response.ok) return { ok: false, provider: 'adp', code: 'ADP_HTTP_ERROR', message: 'Tencent ADP rejected the request.', httpStatus: response.status, latencyMs: this.clock() - requestStartedAt };
      const rawBody = await response.text();
      if (Buffer.byteLength(rawBody, 'utf8') > this.maxResponseBytes) return { ok: false, provider: 'adp', code: 'ADP_RESPONSE_TOO_LARGE', message: 'ADP response exceeded the configured safety limit.' };
      const transcript = parseSseTranscript(rawBody);
      if (transcript.error) return { ok: false, provider: 'adp', code: 'ADP_PROVIDER_ERROR', providerErrorCode: transcript.errorCode, message: 'ADP returned a provider error.', requestId: transcript.requestId, latencyMs: this.clock() - requestStartedAt };
      if (!transcript.completed) return { ok: false, provider: 'adp', code: 'ADP_INCOMPLETE_RESPONSE', message: 'ADP did not return a completed response.', requestId: transcript.requestId, latencyMs: this.clock() - requestStartedAt };
      return {
        ok: true,
        provider: 'adp',
        text: transcript.text,
        raw: transcript.text,
        conversationId: requestBody.ConversationId,
        requestId: transcript.requestId,
        bytes: Buffer.byteLength(transcript.text, 'utf8'),
        completed: true,
        latencyMs: this.clock() - requestStartedAt,
        at: this.clock(),
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'adp',
        code: error.name === 'AbortError' ? 'ADP_TIMEOUT' : 'ADP_NETWORK_ERROR',
        message: 'ADP request failed without exposing credentials.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  AdpClient,
  DEFAULT_ENDPOINT,
  readSseText,
  extractFirstJsonObject,
  parseSseTranscript,
};
