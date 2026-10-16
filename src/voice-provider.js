'use strict';

// Adapter boundary for Tencent TRTC ASR/TTS. Keeping the provider behind this
// interface lets the browser and failure tests run without cloud credentials;
// it never pretends an unavailable provider succeeded.
class VoiceProvider {
  constructor({ env = process.env, transcribe, synthesize } = {}) { this.env = env; this._transcribe = transcribe; this._synthesize = synthesize; }
  status() { return { configured: Boolean(this.env.TRTC_SDK_APP_ID && this.env.TRTC_SDK_SECRET_KEY), provider: 'tencent-trtc', mode: this._transcribe ? 'injected' : 'configured-or-unavailable' }; }
  async transcribe(audio, metadata = {}) {
    if (this._transcribe) return this._transcribe(audio, metadata);
    if (!this.status().configured) return { ok: false, code: 'TRTC_NOT_CONFIGURED', message: 'Tencent TRTC ASR is not configured.' };
    return { ok: false, code: 'TRTC_ADAPTER_PENDING', message: 'TRTC ASR credentials are present, but the provider adapter still requires account verification.' };
  }
  async synthesize(text, metadata = {}) {
    if (this._synthesize) return this._synthesize(text, metadata);
    if (!this.status().configured) return { ok: false, code: 'TRTC_NOT_CONFIGURED', message: 'Tencent TRTC TTS is not configured.' };
    return { ok: false, code: 'TRTC_ADAPTER_PENDING', message: 'TRTC TTS credentials are present, but the provider adapter still requires account verification.' };
  }
}

module.exports = { VoiceProvider };
