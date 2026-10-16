# Tencent ADP live verification

IntentLock uses Tencent Cloud ADP's HTTP SSE conversation endpoint:

`https://wss.lke.tencentcloud.com/adp/v2/chat`

The application must be published before the conversation endpoint can be called. In the ADP console:

1. Create an application named IntentLock.
2. Configure a text-generation model and paste the IntentLock structured-intent prompt into the application instructions.
3. Disable search, tools, and workflows that are not needed for intent extraction.
4. Publish the application.
5. Open the running application's **Call / 调用** panel and copy its `AppKey`.

Create a local `.env` from `.env.example` and set:

```env
INTENTLOCK_MODE=LIVE
ADP_APP_KEY=your-local-app-key
```

Never commit `.env` or paste the key into chat. The runtime sends `AppKey` in the HTTPS request body, as required by the ADP conversation API; Tencent management credentials are not needed by the demo runtime.

Run the local checks first:

```sh
npm test
npm run verify:adp
```

`verify:adp` performs a real ADP request, validates the returned structured intent, runs the deterministic security gates, executes one transfer against the isolated MockBank, and blocks a minimum-balance violation. It writes only a redacted report to `verification/adp-live-report.json`.

If live mode fails, check that the application is published, the AppKey belongs to that published application, the account has model resources/quota, and the local mode is exactly `LIVE`.
