# Design notes

## 1. Logical architecture — where the numbers come from

```
 CSV upload
     │
 [1] Ingestion & validation (ingest.py)
     │   valid Transaction  ──────────────┐     RowError (row, field, reason) ──► shown to user
     ▼                                    │
 [2] Transaction store (store.py)         │  original amount + description saved, never edited
     │   per-user namespace; IDs dedupe   │  overrides, merchant rules, correction & import logs
     ▼                                    │
 [3] Categorization (categorize.py)       │  proposed category: rule map / classifier
     │   effective category = override > user rule > rule map > classifier ≥ 0.80 > Uncategorized
     ▼
 [4] Calculation (report.py)              │  OWNS ALL NUMBERS — integer cents,
     │   category totals, net spending,   │  checks sum(categories) == net spending
     │   budget remaining / % / status    │
     ▼
 [5] Insight (insights.py)                │  text built from the Report only;
     │   optional generator is checked;   │  failure → verified template
     ▼
 [6] Presentation (web.py / cli.py)
     ▲
 [7] User correction ── writes override (or opt-in merchant rule) to [2], then [3]–[5] rerun
```

**Tracing one transaction** — `T2, CITY MARKET, $60.00`:
1. Ingestion parses `"60.00"` → `6000` cents. 2. Store saves `{T2, CITY MARKET, 6000}`.
3. Rule map keyword `CITY MARKET` proposes **Groceries**; no override, so effective = Groceries.
4. Report adds 6000 to Groceries. 5. Insight reads the Groceries total from the report.

**User corrects T2 → Dining:** an override `{T2: Dining}` is saved with a log entry.
Groceries drops $60, Dining gains $60. **Must not change:** T2's amount, description,
any other transaction (T1), net spending ($130 before and after), other customers.

## 2. Google Cloud mapping (target design — the prototype runs locally)

| Responsibility | Service | What it does here |
|---|---|---|
| Application execution | **Cloud Run** | Runs the containerized app: validation, categorization, report calculation, API |
| Uploaded files | **Cloud Storage** | Keeps the original CSV (evidence) in a per-user path; upload triggers import |
| Transactions, overrides, merchant rules, budgets | **Cloud SQL (PostgreSQL)** or **Firestore** | Transactional system of record; unique key `(user_id, transaction_id)` blocks duplicate import |
| History & analytics | **BigQuery** | Aggregate reporting/trends; category totals via tested SQL, not the LLM |
| Categorization model (larger version) | **Vertex AI** endpoint | Returns *(category, confidence)* only; never amounts |
| Generated explanations | **Vertex AI (Gemini)** | Receives the verified report JSON; its text is checked before display |
| Dashboards | Web UI on Cloud Run (or **Looker Studio** on BigQuery for internal analytics) | Displays the report |
| Identity / secrets | **Identity Platform**/IAP, **Secret Manager**, **IAM** | Who the user is; no keys in code |

**Corrections are retained** in the transactional database (overrides + merchant rules + audit log), keyed by user.

**If the insights service times out** after the report succeeded: return the verified report
with the template sentence (or "insight unavailable") — never fail the whole response and never
let the narrative block the numbers.

**Control preventing customer A reading customer B:** the server derives `user_id` from the
authenticated token (not from the request body or a prompt) and every query is scoped
`WHERE user_id = :authenticated_user` (in Cloud SQL, optionally enforced with row-level security;
in Firestore, security rules on `users/{uid}`). Enforced in the server/database, never in a prompt.
The prototype shows the same idea: every `JsonStore` method requires `user_id`, and the web server
takes it from the session cookie.

## 3. Categorization approach

**Prototype — rule map.** Ordered `(keyword, category)` pairs; first keyword found in the
upper-cased description wins. Fully explainable ("keyword 'CITY MARKET'"), zero training data,
deterministic. Sufficient when merchants are few and well-known, and as a high-precision first
layer even in the large system.

**Larger ClearSpend — trained text classifier.** With historical transactions that have
*reviewed* category labels:
- **Inputs (features):** merchant description text → TF-IDF of word and character n-grams
  (handles `CITY MKT #12`, typos, store numbers); optionally amount bucket, MCC code, day of week.
- **Target:** the reviewed category label.
- **Algorithm:** multinomial **logistic regression** (softmax). It learns one weight per feature
  per category by minimizing cross-entropy loss with gradient descent; at prediction it computes
  a score per category, softmax turns scores into probabilities, and the highest is the prediction.
  (Alternatives: linear SVM, or a small transformer/embedding model for very messy text.)
- **Output:** `(category, probability)`.
- **Evaluation:** held-out set; per-category precision/recall, confusion matrix, *and* dollar error
  per category (see `evaluation.py`), because count accuracy can hide large-dollar mistakes.
- **Uncertainty:** if probability < threshold (0.80 here), assign **Uncategorized / needs review**,
  keep it visible, and let the user's correction become a new labeled example.

**Separation of responsibilities**
| Task | Owner |
|---|---|
| Assign a category | rule map / classifier (AI allowed) |
| Calculate category totals and budgets | deterministic, tested code (`report.py`) |
| Write the plain-language explanation | template or LLM, **checked against** the verified report |

## 4. What "learning" means here
- **Transaction override** — fixes one transaction for one user. Default behavior of "Fix".
- **User merchant rule** — explicit opt-in ("always"), affects that user's future transactions from that merchant only.
- **Model retraining** — offline, on many users' reviewed labels, evaluated before deployment; never triggered by a single click and never changes another customer's saved overrides.
