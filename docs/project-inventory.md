# Project Inventory

## Discovery

- Located folder: `/Users/spahen312/Desktop/Actual Desktop/Tencent Hackathon`
- Discovery date: 2026-10-14 (Singapore time)
- Initial state: empty folder
- Existing files changed: none
- Existing credentials found: none

## Workspace created

The project is contained in the `intentlock/` subfolder. Source, tests, demo assets and submission materials will remain under that folder.

## Milestones

1. Workspace discovery and safety boundaries — complete.
2. Deterministic mock payment core — complete.
3. Approval binding and tamper-resistance tests — initial coverage complete; extend in next pass.
4. Tencent ADP adapter with offline fallback, if access is available.
5. UI, demo scenarios and evidence screenshots.
6. Submission package and final verification.

## Milestone 2 verification

- Five automated tests pass.
- Valid payment executes against the simulated ledger.
- Minimum-balance violations are blocked before approval.
- Approval tampering is rejected.
- Expired approval is rejected.
- Unknown recipients are rejected.
- No real banking connection or credentials are used.

## Non-destructive operating rule

Do not replace files without inspecting them first. Do not store secrets in source, screenshots, recordings or submission documents.
