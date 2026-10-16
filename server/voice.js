'use strict';

const { VoiceProvider } = require('../src/voice-provider');

function registerVoiceRoutes(app, { env = process.env, voice = new VoiceProvider({ env }) } = {}) {
  app.get('/api/v2/voice/status', (_req, res) => res.json({ ok: true, ...voice.status() }));
  app.post('/api/v2/voice/transcribe', async (req, res) => {
    if (!req.body?.audioBase64) return res.status(400).json({ ok: false, code: 'AUDIO_REQUIRED', message: 'Provide a bounded PCM recording.' });
    const result = await voice.transcribe(Buffer.from(req.body.audioBase64, 'base64'), { encoding: req.body.encoding || 'pcm_s16le', sampleRate: req.body.sampleRate || 16000, channels: req.body.channels || 1 });
    return res.status(result.ok ? 200 : 503).json(result);
  });
  app.post('/api/v2/voice/synthesize', async (req, res) => {
    const text = String(req.body?.text || '').trim(); if (!text) return res.status(400).json({ ok: false, code: 'TEXT_REQUIRED' });
    const result = await voice.synthesize(text, { voice: req.body.voice || 'default' }); return res.status(result.ok ? 200 : 503).json(result);
  });
}

module.exports = { registerVoiceRoutes };
