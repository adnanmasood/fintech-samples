# Verification report

Verified October 6, 2026 (America/New_York) on macOS with Python 3.13.7 and Chromium 154.0.8037.98.

| Check | Actual result |
|---|---|
| Python suite | 22/22 tests passed in 1.929 seconds |
| HTTP lifecycle smoke | 14/14 checks passed against the actual local server |
| Browser interaction checks | 18/18 checks passed at 1440×1300 and 390×844 |
| Native LaTeX compilation | Both saved sources compiled successfully in Codex's built-in editor |
| Final PDF exports | Tectonic success; course guide 10 pages, supplement 20 pages; no overfull-box warnings |
| PDF visual review | All 30 pages reviewed; screenshot pages reviewed at full size |
| Diagram exports | Four SVGs reviewed; Mermaid sources and stdlib exporter included |
| Distribution ZIP | Integrity and 53 file hashes passed; fresh extraction launched, passed 14 HTTP checks, served bundled assets, and stopped cleanly |
| Docker build and container smoke | Unavailable: the installed client could not reach a running Docker daemon |

## What the tests establish

The Python suite verifies actual process boundaries and complete reverse authorization, approval/decline rules, capture ordering, posted debit and merchant credit exactly once, duplicate/conflicting operations, per-transaction fee rounding, multi-sale batch membership, serialized competing authorizations, failure pause, reset isolation, HTTP error contracts, and real launcher startup/SIGTERM shutdown. The participant failure test deliberately stops an issuer and expects a fault; that diagnostic is not a suite failure.

The HTTP smoke verifies six live PIDs, the $50 authorization hold, unchanged posted funds until clearing, capture without transfer, the clearing debit and obligation, $48.75 settlement, the $1.25 fee reconciliation, retries, cursor/trace export, and fresh reset processes.

The browser suite exercises actual controls and keyboard shortcuts, reads server-observed balances, checks normal-motion visible packet movement and reduced-motion behavior, verifies funding remains visible while settlement is in flight, runs automatic seeded purchases to a settled payment, checks pause, downloads a real trace, and verifies mobile overflow. Normal user flows produced no console or script errors. The deliberately invalid EUR API request correctly returned HTTP 400; its expected network-console diagnostic is separately recorded.

`qa/http-verification.json` and `qa/browser-verification.json` contain the check names. `VERIFICATION.json` records completed and unavailable checks. `data/sample_trace.json` is an actual fictional-session trace exported during browser verification.

## Reproduce

```sh
python3 -m unittest discover -s tests -v
python3 start.py --no-browser
# In another terminal (resets this fictional instructor session):
python3 qa/smoke_http.py http://127.0.0.1:8010
```

For optional development browser checks, install Playwright in your development environment and run `node qa/browser_check.cjs`. A custom installed Chrome binary can be chosen with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Neither Node nor Playwright is required for the demonstration or Python tests.

With Docker's engine running, execute the build/run instructions in README, then run the same HTTP smoke against the published local container port. The Dockerfile has no runtime pip dependencies and is configured for a non-root process, health check, and explicit port; those static properties do not substitute for a completed container run.

## Limits of verification

Windows execution and Python 3.9 execution have not been tested on this machine; their code paths and version-compatible syntax were reviewed. No AWS/GCP/Azure resources were provisioned, and the provider instructions are a forward deployment path. Engineering verification does not establish classroom learning effectiveness; no learner pilot is claimed. Memory state and operation journals reset together, and the project does not promise durable crash recovery.
