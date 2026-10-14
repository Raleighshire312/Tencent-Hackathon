# Implementation Notes

## Tool split

- Codex: primary implementation, code review, testing and local verification.
- Tencent CodeBuddy: optional Tencent-branded coding evidence and Tencent-specific development workflow.
- Tencent WorkBuddy: optional workflow/orchestration evidence; not required for the deterministic payment core.
- Tencent ADP: preferred hosted agent integration if the account and AppKey are available.
- ChatGPT Work/Plus: planning, design critique, documentation and debugging support.

## Architecture boundary

The language model or ADP agent can propose structured intent. Only deterministic application code can validate, approve and execute a mock transfer.

