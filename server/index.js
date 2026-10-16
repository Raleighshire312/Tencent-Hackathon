// IntentLock — AI Agent Security Firewall
// Backend entrypoint. Wires the intent pipeline to HTTP. The pipeline module
// owns the orchestration; this file only deals with request shapes, error
// mapping, and shutdown hygiene.

'use strict';

const path = require('node:path');
const express = require('express');
const { buildBank, scenarios } = require('./seed');
const { loadConfig } = require('../src/config');

const config = loadConfig();
const PORT = config.PORT;
const MODE = config.INTENTLOCK_MODE;

// --- Audit log lives for the lifetime of the process and is exposed via /audit.
const { AuditLog } = require('../src/audit-log');
const { injectIntentPipeline } = require('./intent-pipeline');
const { PersistentStore } = require('../src/persistent-store');
const { registerVoiceRoutes } = require('./voice');

// Single-process state.
const audit = new AuditLog();
const bank = buildBank();
const store = new PersistentStore({ filename: config.INTENTLOCK_DB_PATH || path.join(process.cwd(), 'data', 'intentlock.sqlite') });
const pipeline = injectIntentPipeline({ bank, audit, env: config, mode: MODE });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'demo')));

// Health endpoint for ops + smoke tests.
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'intentlock',
    version: require('../package.json').version,
    node: process.version,
    mode: MODE,
    providerConfigured: Boolean(config.ADP_APP_KEY),
    providerStatus: pipeline.providerStatus(),
    scenarios: scenarios.length,
  });
});

// Mock scenario fixture list so the future frontend can render a picker.
app.get('/scenarios', (_req, res) => {
  res.json({ ok: true, scenarios });
});

// --- Routes wired later by intent-pipeline handlers. These stubs return 501
// if the pipeline didn't register handlers (which never happens at runtime,
// but keeps `npm start` honest during incremental development).
const { registerRoutes } = require('./routes');
registerRoutes(app, { pipeline, bank, audit });
const { registerConversationRoutes } = require('./conversation-v2');
registerConversationRoutes(app, { bank, buildBank, audit, env: config, store });
registerVoiceRoutes(app, { env: config });

// 404 + final error handler.
app.use((req, res) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  // Never echo internal exceptions or stack traces.
  // eslint-disable-next-line no-console
  console.error('[intentlock] unexpected error:', error && error.message);
  res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: 'Internal error.' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[intentlock] listening on http://127.0.0.1:${PORT}  (provider ${MODE})`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[intentlock] received ${sig}, shutting down…`);
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { app, audit, bank, pipeline, store };
