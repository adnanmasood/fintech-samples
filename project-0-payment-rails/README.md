# Project 0: Payment Rails Live

A complete instructor reference demonstration for Adnan Masood, PhD.'s USF AI in FinTech course. Six small Python processes show a fictional card payment traveling from payer to issuer and back, followed by capture, clearing, and settlement.

## Static project guide

The included [static guide](site/) explains the participant roles, payment lifecycle, and unscored exploration checklist. The [PDF guides and diagrams](docs/) are also available in this repository. Run the Python simulator locally using the commands below.

To build and preview the guide locally, use Node 24 and Python 3:

```sh
cd project-0-payment-rails
npm run build
python3 -m http.server 8000 --bind 127.0.0.1 --directory site-dist
```

Open **http://127.0.0.1:8000** for the guide, PDFs, images, and complete simulator source download. For a future Vercel release, use root directory `project-0-payment-rails`, framework Other, build command `npm run build`, and output directory `site-dist`. The hosted guide is static; the simulator runs locally.

## Open the demonstration

Python **3.9 or later** and a recent browser are the only runtime requirements. Extract the entire package before launching; keep its folders together.

```sh
cd project-0-payment-rails
python3 start.py
```

On Windows, use `py -3 start.py` or double-click `start_windows.bat`. On macOS, double-click `start_macos.command` or use the terminal command above. The dashboard opens at **http://127.0.0.1:8010**. Keep the terminal running. Stop with Ctrl+C; the launcher also stops the six participant processes.

For a different port or a launch without opening a browser:

```sh
python3 start.py --port 8020 --no-browser --seed 42
```

The dashboard is a shared instructor session. Browser refresh reconnects to the running demonstration; Reset starts a fresh simulation and six new participants. Stopping and restarting also resets all balances and history.

## Demonstrate one payment

1. Select **Guided**, choose the approved scenario and a **$50.00** payment, then send the purchase.
2. Press **Next Message** until the issuer's decision returns to the payer. Follow payer → merchant → gateway → acquirer → network → issuer, then the reverse response.
3. At **AUTHORIZED**, point to the $50 hold. Payer posted balance is still $500, available funds are $450, and merchant proceeds are $0.
4. **Capture** the selected payment and advance the pending messages. Capture records the merchant's collection instruction.
5. **Clear Batch** and advance messages. In this teaching model, payer posted balance becomes $450, the hold is removed, and $50 awaits settlement.
6. **Settle Batch** and advance messages. Merchant proceeds become **$48.75**; fee allocations total $1.25 and the settlement obligation is completed.

Run the insufficient-funds scenario to show a reverse-path decline without a hold or merchant funding. Replay an authorization to show that an identical retry does not reserve funds twice. Use **Automatic** to see seeded random POS purchases and accelerated capture/clearing/settlement batches; Pause lets you inspect the latest messages.

## What is running

The process cards show actual process IDs and counts of messages handled. Each participant owns its decisions and state. The supervisor routes messages, controls demonstration pacing, records observable events, and serves the local browser API. The dashboard draws from those events and snapshots.

The six participants are payer, merchant/POS, gateway/processor, acquirer, simulated Visa/Mastercard network, and issuer. Visa and Mastercard are labels for the same simplified routing behavior here.

All amounts are integer cents internally. Fees are illustrative: 2% interchange, 0.1% network, and 0.2% plus $0.10 combined processing/acquiring, each rounded half-up per transaction. The network coordinates settlement obligations; its panel does not represent a network-held customer deposit.

## Verify the reference

```sh
python3 -m unittest discover -s tests -v
```

Tests cover participant rules, actual process exchange, balances at each stage, duplicates, conflicts, batching, reset and shutdown. `TEST_REPORT.md` records the checks actually run on the delivered version. The optional development browser check uses Playwright; this dependency is not needed to run the demonstration or its Python tests.

The complete release suite also checks source packaging and rebuilding the extracted guide; those three packaging checks require Node 24. The Python simulator itself has no Node dependency.

## Run the same package in Docker

Docker is optional. From this directory:

```sh
docker build -t payment-rails-live:project0 .
docker run --rm --init --name payment-rails-live -p 127.0.0.1:8010:8010 payment-rails-live:project0
```

Open http://127.0.0.1:8010. Use a different host port if the Python launcher already occupies 8010. In a second terminal, check container readiness:

```sh
docker inspect --format '{{.State.Health.Status}}' payment-rails-live
```

The technical design supplement gives complete VM/container procedures for AWS, GCP and Azure and a forward generation path to independently deployed agents with durable queues and financial state. Cloud deployment has not been performed as part of this package.

## Teaching artifacts

- `docs/00_payment_rails_course_guide.pdf` and matching `.tex`: 10-page instructor guide.
- `docs/00_payment_rails_technical_design.pdf` and matching `.tex`: technical design and cloud deployment/generation supplement.
- `docs/diagrams/`: editable diagram sources and SVG exports.
- `screenshots/`: captures of the implemented dashboard at authorization, decline and settlement.
- `data/`: fictional scenarios; `tests/`: runnable verification.
- `AI_USAGE.md`: the original implementation and AI-use record. Repository CI and `docs/RELEASE_VERIFICATION.md` record release checks.

The sources, documents and evidence are included together in the distribution ZIP. This is an instructor demonstration with an unscored observation checklist, rather than an assessed student assignment.

The source ZIP also includes the static guide, build scripts, manifests, and Apache license. Its `.dockerignore` is generated from the tracked `scripts/source-dockerignore.txt` policy because Vercel omits dotfiles of this name during upload. Keep both policy files identical when updating Docker exclusions.

## Limits and troubleshooting

This is a simplified dual-message, debit-style payment simulation with an accelerated classroom clock. It uses synthetic tokens, fictional funds, local messages and deterministic rules. Authorization holds, full captures, clearing debits and settlement credits are teaching conventions; actual card products and schemes vary.

Financial state and idempotency records exist only within the current run. The project does not implement a durable ledger, crash recovery, partial capture, refunds, disputes, real payment rails, card authentication or model-based financial decisions. A participant failure pauses the demonstration and requires Reset.

If Python is unavailable, install Python 3.9 or newer. If the port is occupied, use `--port 8020`. If no browser opens, visit the printed address manually. Use the launcher rather than opening `web/index.html` directly. If the dashboard loses connection, check that the terminal is still running. If a process fails, inspect the visible fault and console log, then Reset.
