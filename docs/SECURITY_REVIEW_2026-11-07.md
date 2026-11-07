# Security and repository consistency review — 2026-11-07

This review covers the public `adnanmasood/fintech-samples` repository after student PRs #12, #16 and #19 were merged. It is a source/configuration review, **not** a penetration test or a production deployment approval.

## Remediated in this change

| Finding | Change |
|---|---|
| Generated budget history committed as `student-projects/personal-budget-c4e81a/var/store.json` | Removed from the current tree; added project/root ignore rules and a publication-policy rejection for future runtime state, local databases, keys and credentials |
| Incomplete course project catalog | Linked all eight current implementations and distinguished the high-risk trading prototype from the instructor reference |
| Student code had no automated test coverage in repository CI | Added Python test coverage for the course projects and typecheck/unit tests for the Solana submission |
| Solana bot could enter live mode after wallet setup and dashboard toggle | Added a fail-closed **server-side operator opt-in**. Without `LIVE_TRADING_OPT_IN=I_ACCEPT_REAL_FINANCIAL_RISK`, effective mode remains paper and live execution preflight refuses every real order, even if a wallet key is configured |
| HarborClaim session cookies used a hard-coded public fallback signing key | Replaced the fallback with an ephemeral random key; the app warns when a stable `SESSION_SECRET_KEY` is missing, and uses Secure cookies automatically in Azure (or when explicitly configured) |

## Outstanding risks — address before any production use

1. **Trading bot dependencies:** The student's README reports **19 npm advisories** at submission, including **2 critical** (with a subset in runtime dependencies). The new CI reports production advisories but does not silently upgrade or certify affected packages. Run `npm audit`, review direct/transitive dependencies and the lockfile, then test upgrades before using the service.
2. **Trading bot local API:** The Fastify server binds to `127.0.0.1` and has no authenticated operator API. Loopback binding and restricted CORS are useful but are **not authorization**, and CORS alone does not prevent cross-origin request forgery. Never expose this service through a public host, tunnel or reverse proxy; independent security review and authentication are mandatory before any operation involving real funds. The new opt-in is an additional safeguard, not a production authorization mechanism.
3. **Other student demos:** HarborClaim, the wallet demo and the budget demo use prototype-grade authentication/session behavior and do not uniformly implement CSRF controls, rate limits, secure upload scanning or production data retention policies. Keep them local and use **fictional information only**.
4. **Committed history:** Removing a file from `main` does **not** erase it from public Git history, forks or existing clones. The removed budget state was a fictional demonstration; any future discovery of a genuine secret or personal record requires incident assessment, credential rotation and possible history remediation.
5. **Repository controls:** This integration received HTTP 403 when inspecting `main` branch protection. An administrator should confirm branch rulesets (required reviews, required checks, restricted direct pushes), GitHub secret scanning and Dependabot alerting. No assumption is made about their current settings.
6. **Browser CI:** The `main` workflow run immediately after merging #19 failed one FinTech Algorithms PSI-drift browser assertion (300 browser tests passed). This is independent of the student project's directory. Verify whether the input-validation interaction is intermittent or requires a UI/test fix before claiming all checks are green.
7. **Privacy and visual verification:** Automated checks cannot prove anonymity in screenshots, PDF content, past commit metadata, or all third-party dependencies. Public authorship and commit identity remain exposed. Human review of images, accessibility, and the deployed sites is still necessary.

## Operational baseline

- The Vercel exclusion file keeps `student-projects/` out of instructor-site deployment payloads. The two published instructor applications are separate from local student projects.
- CI uses read-only repository permissions and fetches code without persisting checkout credentials.
- Do not use real claims, wallet secrets, financial account data, customer identifiers, or private credentials in this public classroom repository.
- Keep student implementation fixes isolated from the instructor reference applications, use pull requests, and evaluate CI and dependency advisories before merging.

## Validation

- `python3 scripts/check-publication.py` must pass on the current source tree.
- The `Verify course projects` workflow now runs each Python student's standard-library tests, the Solana bot's typecheck/unit tests, and existing instructor-site checks. A successful workflow does not make the student apps production safe.
- This change is intended to be merged only after its own CI and diff are reviewed.