# AI-use record

## Request and decisions

The instructor requested Project 0 as a minimal, visually clear reference implementation of payer → merchant → gateway/processor → acquirer → Visa/Mastercard network → issuer. The agreed scope is six separate rule-based Python programs, the full core payment lifecycle, a local browser dashboard, teaching artifacts and guides for all three clouds.

The instructor selected an instructor-only demonstration and Python's standard library rather than an assessed student exercise or a web-framework dependency.

## Generation approach

Codex generated the reference implementation, dashboard, tests and documents. Parallel implementation tasks covered the Python participants/supervisor, bundled HTML/CSS/JavaScript dashboard, and LaTeX teaching/technical documents. The main task integrated those pieces, reviewed the state transitions and protocol, ran verification, captured actual screenshots and packaged the distribution.

The bounded instructions required role-owned financial decisions, real process exchange, integer cents, stage-specific effects, idempotency and batch reconciliation. UI instructions required animation from actual events, a complete reverse response path, readable balances, guided and automatic modes, and reduced-motion support. Document instructions required the existing navy/teal course format and an explicit distinction between implemented local behavior and proposed cloud evolution.

## Human-provided source

The instructor supplied the pasted article “Agentic Payments 101 (1/2): How the Card Payment System Works” by Adnan Masood, PhD. Existing student technical design guides supplied the course's artifact structure and visual conventions. Official payment/cloud documentation informs the linked further reading and deployment guidance.

## Verification and interpretation

See `TEST_REPORT.md` and `VERIFICATION.json` for actual results and platform limits. Test counts are recorded after execution, not inferred from generated code. Screenshots are captured from the running implementation. No cloud resources, external messages or GitHub submissions are claimed.

“Agent” in this project means a small deterministic participant program with an input queue, rules, state and output messages. No model API is called and no generated text makes a financial approval decision.
