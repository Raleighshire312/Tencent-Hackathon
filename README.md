# IntentLock: Proof-Carrying Payments

Tencent Cloud Singapore 2026 DBS Banking Track MVP.

This workspace is intentionally self-contained. IntentLock is a conversational banking planner: natural language becomes a versioned multi-action plan, a deterministic guardian checks every consequence, and signed authorization is required before the mock bank executes anything.

## Current status

- Milestone 6: multi-action conversational plan, clarification loop, guardian evidence, and signed demo authorization are available at `/api/v2/conversations`.
- The v2 flow now persists visitor sessions and synthetic bank state in SQLite (`INTENTLOCK_DB_PATH`), uses an HTTP-only session cookie, and exposes replay-safe authorization, event, cancellation, risk-approval, and voice-adapter endpoints.
- Simulator authorization is intentionally opt-in with `ALLOW_AUTH_SIMULATOR=true`; consequential demo plans additionally require the separate presenter header flow when `ALLOW_RISK_SIMULATOR=true`. These are demonstrations of binding and policy gates, not real DBS controls or biometrics.
- `LIVE` mode fails closed unless both planner and guardian AppKeys are configured. TRTC status is reported by `/api/v2/voice/status`; unavailable ASR/TTS never silently falls back to offline AI.
- `OFFLINE_DEMO` mode is explicit and uses deterministic local parsing; it makes no AI request.
- `LIVE` mode requires Tencent ADP credentials and fails closed on unavailable or malformed ADP output.
- Real transfers are not supported; all transactions are simulated in the in-process MockBank.

## Safety boundary

No real banking credentials, payment credentials, or private Tencent keys belong in this directory. Use `.env` locally when integration begins and keep only redacted examples and screenshots in project materials.

## Run locally

```sh
cp .env.example .env
npm test
npm start
```

Open <http://127.0.0.1:8787/> for the browser demo. The UI calls the actual `/prepare`, `/approve`, `/execute`, `/health`, `/ledger`, and `/audit` endpoints.

The browser demo also exercises the v2 conversation flow: a transfer, bill payment, and stock purchase can be combined into one dependent plan. Ambiguous beneficiaries become clarification questions. The authorization simulator signs the exact plan hash and rejects replay or altered plans.

To use Tencent ADP, set `INTENTLOCK_MODE=LIVE` and `ADP_APP_KEY` in the local `.env`. Never paste credentials into chat or commit `.env`. In LIVE mode an unavailable, hostile, refused, or malformed ADP response is rejected; it is never silently parsed offline.

See [Tencent ADP live verification](docs/tencent-adp-setup.md) for console setup and `npm run verify:adp`.

## Security boundary

Recipient verification is always enforced by trusted application-side records. Neither natural-language release phrases nor AI fields can disable it. Every proposal is bound to a SHA-256 fingerprint, approval identity, expiry, current balance, recipient verification state, and a per-account execution lock.

