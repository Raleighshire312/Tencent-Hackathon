// HTTP route handlers for the IntentLock backend.
// Each route delegates to the intent pipeline. The pipeline owns the
// orchestration; we only translate HTTP <-> JS here.

'use strict';

function notImplemented(res, name) {
  res.status(501).json({ ok: false, code: 'NOT_IMPLEMENTED', message: `${name} not wired yet in this build` });
}

function registerRoutes(app, { pipeline, bank, audit, legacyEnabled = false }) {
  // 1) Interpret: run the full adversarial pipeline up to (but not including)
  //    the MockBank proposal. Returns the structured intent + reasoning chain.
  app.post('/interpret', async (req, res, next) => {
    try {
      const { message, untrustedContent = '', userId = 'demo-user' } = req.body || {};
      if (typeof message !== 'string') {
        return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '`message` (string) is required.' });
      }
      const result = await pipeline.interpret({ message, untrustedContent, userId });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 2) Prepare: runs interpret + MockBank.preparePayment in one call. Returns
  //    the proposal envelope with a SHA-256 fingerprint that the client must
  //    echo back in /approve. This is the standard "AI proposes, human reviews
  //    the exact fingerprint" workflow.
  app.post('/prepare', async (req, res, next) => {
    try {
      const { message, untrustedContent = '', userId = 'demo-user' } = req.body || {};
      if (typeof message !== 'string') {
        return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '`message` (string) is required.' });
      }
      const result = await pipeline.prepare({ message, untrustedContent, userId });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 3) Approve: the user explicitly signs the proposal fingerprint.
  app.post('/approve', (req, res, next) => {
    if (!legacyEnabled) return res.status(410).json({ ok: false, code: 'LEGACY_ROUTE_DISABLED', message: 'Use the signed v2 conversation authorization flow.' });
    try {
      const { proposalFingerprint, userId = 'demo-user' } = req.body || {};
      if (typeof proposalFingerprint !== 'string') {
        return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '`proposalFingerprint` (string) is required.' });
      }
      const result = pipeline.approve({ proposalFingerprint, userId });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 4) Execute: triggers the MockBank.executeApproval gate. This is where
  //    every counterfactual re-check (verified flag, balance, replay) runs.
  app.post('/execute', (req, res, next) => {
    if (!legacyEnabled) return res.status(410).json({ ok: false, code: 'LEGACY_ROUTE_DISABLED', message: 'Use the signed v2 conversation authorization flow.' });
    try {
      const { approvalId, userId = 'demo-user' } = req.body || {};
      if (typeof approvalId !== 'string') {
        return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '`approvalId` (string) is required.' });
      }
      const result = pipeline.execute({ approvalId, userId });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 5) Audit timeline: returns the in-memory hash-chained audit log. Exposed
  //    so the frontend can render the decision provenance and judges can see
  //    that every gate produced a tamper-evident record.
  app.get('/audit', (_req, res) => {
    res.json({ ok: true, entries: audit.entries() });
  });

  // 6) Convenience: bank ledger snapshot (mock).
  app.get('/ledger', (_req, res) => {
    res.json({ ok: true, ledger: bank.ledger, accounts: Object.fromEntries(Object.entries(bank.accounts).map(([id, a]) => [id, { id: a.id, displayName: a.displayName, balanceCents: a.balanceCents }])) });
  });
}

module.exports = { registerRoutes };
