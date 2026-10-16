'use strict';

const crypto = require('node:crypto');
const { parsePlan, resolvePlan, calculatePlan, clone, PLAN_VERSION } = require('../src/transaction-plan');
const { AuthorizationStore } = require('../src/authorization');
const { createPlanProvider } = require('../src/providers/plan-provider');
const { scanUserMessage } = require('../src/injection-guard');
const { assessPlan } = require('../src/risk-policy');

function cookieValue(req, name) {
  const item = String(req.get('cookie') || '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function registerConversationRoutes(app, { bank: defaultBank, buildBank, audit, env = process.env, store }) {
  const provider = createPlanProvider({ env });
  const auth = new AuthorizationStore({ store });
  const sessions = new Map();
  const sessionId = (req, res, create = false) => {
    let id = cookieValue(req, 'intentlock_session');
    if (!id && create) { id = crypto.randomUUID(); res.set('Set-Cookie', `intentlock_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/`); }
    return id;
  };
  function getSession(req, res, id) {
    const sid = sessionId(req, res);
    if (!sid) return null;
    let session = sessions.get(id) || store?.getConversation(id);
    if (!session || session.sessionId !== sid) return null;
    if (!session.bank) session.bank = buildBank(store?.bankSnapshot(sid) || {});
    sessions.set(id, session);
    return session;
  }
  function persist(session) { sessions.set(session.planId, session); store?.saveConversation(session.planId, session); store?.saveSession(session.sessionId, session.bank); }
  function addEvent(session, type, message, data = {}) { const event = { id: crypto.randomUUID(), at: new Date().toISOString(), type, message, data }; session.events.push(event); store?.appendAudit(session.sessionId, 'event', { planId: session.planId, ...event }); }
  function publicBank(session) {
    return {
      accounts: Object.fromEntries(Object.entries(session.bank.accounts).map(([id, account]) => [id, { id: account.id, displayName: account.displayName, balanceCents: account.balanceCents }])),
      ledger: (session.bank.ledger || []).map((entry) => ({ transactionId: entry.transactionId, type: entry.type, amountCents: entry.amountCents, sourceAccountId: entry.sourceAccountId, recipientId: entry.recipientId || null, billId: entry.billId || null, symbol: entry.symbol || null, quantity: entry.quantity || null, status: entry.status, executedAt: entry.executedAt })),
    };
  }
  function publicPlan(session) { return { ...clone(session.plan), id: session.planId, revision: session.revision, guardian: session.guardian, riskApproved: session.secondaryApproval === session.plan.planHash, events: session.events, providerEvidence: session.providerEvidence, bank: publicBank(session), authorization: session.authorization ? { id: session.authorization.id, planId: session.planId, planHash: session.authorization.planHash, revision: session.authorization.revision, mode: session.authorization.mode, verifiedAt: session.authorization.verifiedAt, authorizationHash: session.authorization.authorizationHash } : null }; }
  function comparePlans(planner, guardian) {
    const fields = (p) => (p?.actions || []).map((a) => ({ type: a.type, recipientId: a.recipientId || null, amountCents: a.amountCents || null, sourceAccountId: a.sourceAccountId || null, currency: a.currency || null, symbol: a.symbol || null, billId: a.billId || null, quantity: a.quantity || null, dependency: a.dependency || null }));
    const left = JSON.stringify(fields(planner)); const right = JSON.stringify(fields(guardian));
    return { ok: left === right, status: left === right ? 'agreed' : 'disagreement', independent: guardian, differences: left === right ? [] : ['Planner and guardian disagree on transaction fields.'] };
  }
  async function makePlan(session, message) {
    const result = await provider.createPlan({ message, context: session.turns, bank: session.bank });
    if (!result.ok) return result;
    session.plan = result.plan;
    session.guardian = result.guardianPlan ? comparePlans(result.plan, result.guardianPlan) : { ok: true, status: 'deterministic_checks', independent: null, differences: [] };
    if (result.differences?.length) { session.guardian.ok = false; session.guardian.status = 'disagreement'; session.guardian.differences = result.differences; }
    session.providerEvidence = result.providerEvidence || { mode: result.mode, provider: result.provider, guardianSource: result.guardianSource };
    return result;
  }
  function failPlan(session, result) { session.plan = { version: PLAN_VERSION, state: 'blocked', actions: [], findings: [{ code: result.code, message: result.message, details: result.details || null }] }; addEvent(session, 'blocked', result.message, { code: result.code, details: result.details || null }); persist(session); }

  app.post('/api/v2/conversations', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, code: 'MESSAGE_REQUIRED' });
    const guard = scanUserMessage(message); if (!guard.ok) return res.status(400).json({ ok: false, code: guard.code, stage: 'injection', message: 'I cannot process instruction overrides inside a banking request.' });
    const sid = sessionId(req, res, true);
    let snapshot = store?.bankSnapshot(sid); const sessionBank = snapshot ? buildBank(snapshot) : buildBank ? buildBank() : defaultBank;
    if (!snapshot) store?.saveSession(sid, sessionBank);
    const session = { sessionId: sid, planId: crypto.randomUUID(), revision: 1, originalMessage: message, turns: [{ role: 'customer', text: message, at: Date.now() }], events: [], auth: null, authorization: null, secondaryApproval: null, bank: sessionBank, createdAt: Date.now(), plan: { version: PLAN_VERSION, state: 'understanding', actions: [] }, guardian: null };
    const result = await makePlan(session, message);
    if (!result.ok) failPlan(session, result);
    else { addEvent(session, 'understanding', 'Mapped your request into a transaction plan.'); if (session.plan.unresolved?.length) addEvent(session, 'clarification', 'I need one detail before I can prepare this plan.'); else { addEvent(session, 'tools', 'Retrieved balances, trusted payees, bills, and market quote.'); addEvent(session, 'guardian', session.guardian.ok ? 'Guardian checks agreed with the draft.' : 'Guardian blocked the draft pending review.'); } persist(session); }
    audit?.append('conversation', { stage: 'plan', planId: session.planId, revision: session.revision, state: session.plan.state, provider: session.providerEvidence?.provider || session.providerEvidence?.mode, messageRedacted: '[synthetic demo transcript]' });
    return res.json({ ok: true, sessionId: sid, ...publicPlan(session) });
  });

  app.post('/api/v2/conversations/:id/turns', async (req, res) => {
    const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
    const message = String(req.body?.message || '').trim(); if (!message) return res.status(400).json({ ok: false, code: 'MESSAGE_REQUIRED' }); if (!scanUserMessage(message).ok) return res.status(400).json({ ok: false, code: 'INJECTION_BLOCKED' });
    session.turns.push({ role: 'customer', text: message, at: Date.now() }); session.revision += 1; session.auth = null; session.authorization = null;
    const correction = message.match(/(?:make|change|set)\s+(.+?)\s+(?:transfer|payment)?\s*(?:to|at)\s+(?:s\$|\$)?([0-9]+(?:\.[0-9]{1,2})?)/i);
    if (correction && session.plan.actions?.length) { const target = session.plan.actions.find((a) => a.type === 'transfer' && message.toLowerCase().includes(String(a.recipientDisplayName || a.recipientAlias).toLowerCase())); if (target) target.amountCents = Math.round(Number(correction[2]) * 100); session.plan = calculatePlan(session.plan, session.bank); }
    else { const resolved = resolvePlan(session.plan, message, session.bank); if (resolved !== session.plan && session.plan.unresolved?.length) session.plan = calculatePlan(resolved, session.bank); else { const result = await makePlan(session, `${session.originalMessage}\nCustomer correction: ${message}`); if (!result.ok) return failPlan(session, result); } session.plan = calculatePlan(session.plan, session.bank); }
    addEvent(session, 'revision', 'Recalculated the plan and invalidated earlier approvals.'); persist(session); res.json({ ok: true, sessionId: session.sessionId, ...publicPlan(session) });
  });

  app.post('/api/v2/authorize/simulator/register', (req, res) => { const sid = sessionId(req, res); if (!sid) return res.status(401).json({ ok: false, code: 'SESSION_REQUIRED' }); const result = auth.registerSimulatorKey({ sessionId: sid, publicKey: req.body?.publicKey }); return res.status(result.ok ? 200 : 400).json(result); });
  app.post('/api/v2/conversations/:id/authorize/challenge', (req, res) => {
    const session = getSession(req, res, req.params.id); if (!session || session.plan.state !== 'ready_for_approval' || !session.guardian?.ok) return res.status(409).json({ ok: false, code: 'PLAN_NOT_READY', message: 'The plan must pass all checks before authorization.' });
    const risk = assessPlan(session.plan, session.bank); session.risk = risk; if (!risk.ok) return res.status(409).json(risk); if (risk.secondaryRequired && session.secondaryApproval !== session.plan.planHash) return res.status(409).json({ ok: false, code: 'SECONDARY_APPROVAL_REQUIRED', message: 'This plan requires separate presenter approval under the illustrative demo policy.', risk });
    if (String(env.ALLOW_AUTH_SIMULATOR).toLowerCase() !== 'true') return res.status(501).json({ ok: false, code: 'PASSKEY_NOT_CONFIGURED', message: 'Native passkey authorization is not configured; simulator mode is disabled.' });
    const challenge = auth.issue({ planId: session.planId, planHash: session.plan.planHash, revision: session.revision, sessionId: session.sessionId }); session.plan.state = 'authorization_pending'; session.auth = challenge; persist(session); audit?.append('authorization-challenge', { planId: session.planId, revision: session.revision, planHash: session.plan.planHash, mode: challenge.mode });
    res.json({ ok: true, challenge: { id: challenge.id, nonce: challenge.nonce, expiresAt: challenge.expiresAt, revision: challenge.revision, mode: challenge.mode }, plan: publicPlan(session) });
  });
  app.post('/api/v2/conversations/:id/presenter/secondary-approval', (req, res) => { const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' }); if (String(env.ALLOW_RISK_SIMULATOR).toLowerCase() !== 'true' || req.get('x-intentlock-presenter') !== 'demo-presenter') return res.status(403).json({ ok: false, code: 'PRESENTER_APPROVAL_REQUIRED' }); if (session.plan.state !== 'ready_for_approval' || !session.guardian?.ok) return res.status(409).json({ ok: false, code: 'PLAN_NOT_READY', message: 'Presenter approval is available only after the plan passes validation and Guardian checks.' }); if (session.secondaryApproval === session.plan.planHash) return res.json({ ok: true, risk: assessPlan(session.plan, session.bank), plan: publicPlan(session) }); session.secondaryApproval = session.plan.planHash; addEvent(session, 'risk', 'Separate presenter approval recorded for this exact plan.'); persist(session); res.json({ ok: true, risk: assessPlan(session.plan, session.bank), plan: publicPlan(session) }); });
  app.post('/api/v2/conversations/:id/authorize/verify', (req, res) => {
    const session = getSession(req, res, req.params.id); if (!session || !session.auth) return res.status(409).json({ ok: false, code: 'AUTH_CHALLENGE_INVALID' });
    const result = auth.verify({ challengeId: session.auth.id, signature: req.body?.signature, publicKey: req.body?.publicKey, sessionId: session.sessionId, revision: session.revision }); if (!result.ok) return res.status(403).json(result);
    session.authorization = result.authorization; store?.saveAuthorization(result.authorization); session.plan.state = 'ready_for_approval'; persist(session); audit?.append('authorization-verified', { planId: session.planId, revision: session.revision, authorizationHash: result.authorization.authorizationHash, mode: 'SIMULATOR' }); res.json({ ok: true, authorization: session.authorization, plan: publicPlan(session) });
  });
  app.post('/api/v2/conversations/:id/execute', (req, res) => {
    const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
    if (!session.authorization || session.authorization.planHash !== session.plan.planHash || session.authorization.revision !== session.revision) return res.status(403).json({ ok: false, code: 'AUTHORIZATION_REQUIRED' });
    const result = session.bank.executePlan({ ...session.plan, state: 'ready_for_approval' }, Date.now(), { userId: session.sessionId, idempotencyKey: session.authorization.authorizationHash });
    if (!result.ok) { session.plan.state = 'blocked'; addEvent(session, 'blocked', result.message, { code: result.code }); persist(session); return res.status(409).json(result); }
    store?.consumeAuthorization(session.authorization.id); session.plan.state = 'completed'; addEvent(session, 'completed', 'All approved actions executed atomically.'); persist(session); audit?.append('execute-plan', { planId: session.planId, revision: session.revision, actionCount: result.entries.length, authorizationHash: session.authorization.authorizationHash }); res.json({ ok: true, result, plan: publicPlan(session) });
  });
  app.post('/api/v2/conversations/:id/cancel', (req, res) => { const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' }); session.auth = null; session.authorization = null; session.plan.state = 'cancelled'; addEvent(session, 'cancelled', 'The plan and any pending authorization were cancelled.'); persist(session); res.json({ ok: true, plan: publicPlan(session) }); });
  app.get('/api/v2/conversations/:id', (req, res) => { const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' }); res.json({ ok: true, sessionId: session.sessionId, ...publicPlan(session) }); });
  app.get('/api/v2/conversations/:id/events', (req, res) => { const session = getSession(req, res, req.params.id); if (!session) return res.status(404).json({ ok: false, code: 'CONVERSATION_NOT_FOUND' }); res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); for (const event of session.events) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); res.end(); });
}

module.exports = { registerConversationRoutes };
