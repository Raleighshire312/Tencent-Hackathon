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
  return body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => parseDataLine(line.slice(5).trim())).join('');
}

class AdpClient {
  constructor({ appKey, endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.appKey = appKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  isConfigured() { return Boolean(this.appKey && this.fetchImpl); }

  async generateIntent({ message, visitorId = 'intentlock-demo-user', conversationId } = {}) {
    if (!this.isConfigured()) return { ok: false, provider: 'adp', code: 'ADP_NOT_CONFIGURED', message: 'ADP is not configured; use the offline provider.' };
    if (!message || typeof message !== 'string') return { ok: false, provider: 'adp', code: 'INVALID_MESSAGE', message: 'A text message is required.' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.appKey}`, Accept: 'text/event-stream' },
        body: JSON.stringify({ content: message, visitorId, ...(conversationId ? { conversationId } : {}) }),
        signal: controller.signal,
      });
      const text = await readSseText(response);
      return { ok: true, provider: 'adp', text, conversationId };
    } catch (error) {
      return { ok: false, provider: 'adp', code: error.name === 'AbortError' ? 'ADP_TIMEOUT' : 'ADP_REQUEST_FAILED', message: 'ADP request failed without exposing credentials.' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { AdpClient, DEFAULT_ENDPOINT, readSseText };
