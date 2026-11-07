# Student projects and instructor sample

The project folders below contain **fictional classroom data**. They are student-authored demonstrations, not audited production systems or approved financial services. Only the instructor reference sites are published; student applications are **not deployed by this repository's CI**.

## Instructor sample

| Project | Description |
|---|---|
| [Payment Rails Live](project-0-payment-rails/) | Six-participant local payment simulator and static guide. No real payment network. |

## Student submissions

| Course project | Implementation |
|---|---|
| [1. Loan application review](ahmad-abuadas/) | Deterministic loan-intake, mock evidence and risk scoring, underwriter review, and audit trail. |
| [2. Digital wallet transfer](eli-campbell/usf-fintech-digital-wallet/) | Fictional wallet balances, transfer validation, deduplication, and receipts. |
| [3. Card fraud screening](card-fraud-screening-7f3c2a/) | Updated Streamlit implementation, fraud decision rules, blocked-card and timeout handling. [Earlier console version](huei-en-cho/). |
| [4. Bank account onboarding](Ethan-Fray/bank-onboarding-checker-461cfa/) | Compare fictional signup information with a mock ID extraction; flag conflicts for review. |
| [5. Supplier invoice intake](andreana.irving/usf-fintech-supplier-invoice/) | Validate invoices and prevent duplicate submission. |
| [6. Personal budget assistant](personal-budget-c4e81a/) | CSV expense categorization, exact arithmetic, rejected-row reporting, and budget insights. |
| [7. Insurance claim intake](asim-khan/claim-intake-streamlit/) | Streamlit completeness checker and documented tests. [Extended HarborClaim application](asim-khan/) and [original submission](harborclaim-insurance-intake-b41f7e2c/). |
| [8. Investment research assistant](Investment-Research-Assistant-80123c/) | Restricted local retrieval with line citations and explicit no-match behavior. |

### Additional demonstration

[Solana multi-agent trading bot](solana-trading-bot-538bd7/) is a **separate, higher-risk research exercise**. It includes wallet-handling and live execution code, so it must never be deployed as an internet-accessible or production trading service without an independent security review, dependency remediation, robust authentication, authorization, and operational safeguards. Its paper-mode results are simulated, not financial performance evidence.

## Privacy and local execution

- Work only with fictional sample data. Do not upload real financial records, identity documents, passwords, API keys, wallet secrets, or personal information.
- Run projects locally according to their own READMEs. Treat optional features and mock authentication as demonstration-only.
- Individual submissions may have different UIs, frameworks, and limitations. The course project's common standards are traceable rules, normal and failure tests, clear limitations, and no undisclosed production side effects.
- New contributions should follow [CONTRIBUTING.md](../CONTRIBUTING.md) and the [README template](../docs/PROJECT_README_TEMPLATE.md); keep code in an isolated project folder.

The repository is public. Commit metadata, PR authorship, and existing history remain visible even after files are removed from the latest branch.