# HarborClaim — Insurance Claim Intake System

USF FIN 6934 (AI in Finance), System Design Studio — Assignment 7. HarborClaim is a
fictional insurtech startup; this is my take-home build for its claim intake system.

The live, continuously updated version of this project (including the fictional sample
PDFs and documentation screenshots not included in this submission folder) is at
<https://github.com/i-asimkhan/harborclaim-insurance-intake>.

## Quick start (run the full web app)

The graded minimum (`main.py`) needs nothing but Python — see "Run it" below. This is
for the full app: real file storage, a database, sign-in, adjuster review, the mock
extraction/summary/notification pipeline.

```bash
# 1. Install dependencies into a venv
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS/Linux

# 2. Set up login credentials
cp .env.example .env
# Claimant login needs a real Google OAuth app -- one-time setup, see
# "Accounts and privacy" below. Adjuster login needs none of that:
.venv/Scripts/python.exe -c "import storage; storage.init_db(); print(storage.create_adjuster('a.irving', 'Adjuster Name'))"
# ^ prints a password once -- copy it, you'll use it to sign in as that adjuster.

# 3. Run it
.venv/Scripts/python.exe -m uvicorn app:app --reload --port 8123
```

Open **<http://127.0.0.1:8123/>** — claimant sign-in is on that page; adjuster sign-in is
at **<http://127.0.0.1:8123/adjuster/login>** (the username/password from step 2).

The port matters — `8123` has to match the redirect URI registered in Google Cloud
Console (see "Accounts and privacy" below) or claimant sign-in will fail with
`redirect_uri_mismatch`.

## What this is

The minimum working example from the take-home spec: a claim completeness checker.
Given a fictional claim (policy ID, incident date, description, and a list of
supporting documents), it returns `READY_FOR_REVIEW` if everything required is
present, or `NEEDS_INFORMATION` naming exactly which fields are missing.

**It does not approve, decline, or pay a claim.** That decision — and any judgment
about coverage — stays with a human adjuster. This component only decides whether a
claim has enough information to reach that adjuster in the first place.

## Setup

No dependencies — standard library only. Requires Python 3.9+.

## Run it

```bash
python main.py
```

```
[CLM-1001] READY_FOR_REVIEW
{
  "status": "READY_FOR_REVIEW",
  "missing": []
}

[CLM-1002] NEEDS_INFORMATION -- missing: incident_date
{
  "status": "NEEDS_INFORMATION",
  "missing": [
    "incident_date"
  ]
}
```

## Test it

```bash
python -m unittest -v
```

5 tests: a complete claim, a claim missing `incident_date`, a claim missing
`documents`, a claim missing everything (confirms all missing fields are named at
once, not just the first one found), and a check that the result never contains a
coverage/payout word (`approve`, `deny`, `decline`, `pay`).

## What counts as "required"

- `policy_id`, `incident_date`, `description` — must be present and a non-blank string.
- `documents` — must be present and a non-empty list. Contents aren't validated (a
  document's name alone doesn't say whether it's the *right* document — see Limitations).

## Limitations (on purpose, for this minimum version)

- Field values aren't validated beyond "non-blank" at the `main.py` level — that's what
  the web UI's separate `validation.py` is for (see below).
- `documents` only checks the list isn't empty; it doesn't check that the *right*
  documents were uploaded for the claim type (e.g., a police report for an auto claim).
- No persistence at the `main.py` level — that's a pure function over one claim at a
  time; the web UI below adds a real database on top of it.

## Mocks

All claim data (`CLM-1001`, `CLM-1002`, policy IDs, document names) is fictional,
written for this demo. No real customer or policy data is used anywhere in this
folder. (The web UI stretch below has three more mocked stages of its own — fact
extraction, summary generation, notifications — documented in full in `MOCKS.md`.)

---

## Optional stretch: web UI

Beyond the graded minimum above, this folder also has a small FastAPI web front end
(`app.py` + `templates/` + `static/`) so the completeness checker can be driven from a
browser instead of only the console demo. It's optional — the graded part is
`main.py`/`test_main.py` above, unchanged and untouched by any of this.

### Tech stack

| Layer | What |
|---|---|
| Backend | FastAPI + Uvicorn |
| Templating | Jinja2 (server-rendered HTML, no JS framework) |
| Styling | Plain CSS (`static/style.css`), IBM Plex fonts |
| Testing | `pytest` + FastAPI's `TestClient` (`tests/test_app.py`), plus a separate real-browser suite (`tests/test_ui.py`, Playwright) |
| State | SQLite (`storage.py`, `data/harborclaim.db`) — persists across restarts |
| Evidence storage | Uploaded files saved to `data/uploads/<claim_id>/`, standard library only |
| Auth (claimants) | Sign in with Google (`auth.py`, Authlib) |
| Auth (adjusters) | Provisioned username/password, `hashlib.scrypt`, standard library only — see "Accounts and privacy" below |

### Set up the web UI

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS/Linux
```

### Accounts and privacy: two roles, two separate login mechanisms

Claimants and adjusters don't share a login screen — they're provisioned
completely differently, on purpose, because they're not the same kind of
account in the real world:

- **Claimants sign in with Google** (`/auth/login`, `auth.py`, Authlib). Signing
  in for the first time *creates* the account; there's no separate sign-up
  step (`storage.get_or_create_user`). A claimant only ever sees their own
  claims — `/claims` is filtered to `claimant_email`, and `/claims/{id}`
  returns `403` for anyone else's claim.
- **Adjusters sign in with a username and password** at a completely separate
  page, `/adjuster/login` — no Google involved at all. Credentials are
  generated by `storage.create_adjuster(username, name)`, run by hand, never
  through any HTTP route — mirroring the real-world fact that most US states
  (Florida included) require a real adjuster license before someone can hold
  the role. Passwords are salted and hashed with `hashlib.scrypt` and checked
  with `hmac.compare_digest`; the plaintext password is returned exactly once,
  by `create_adjuster`, and never stored or logged again.

One browser can hold a claimant session and an adjuster session at the same
time (different keys in the same session cookie). Each side's logout route
only ever pops its own session key.

### Separation of duties

`create_adjuster` takes an optional third argument, `linked_claimant_email`,
that records when an adjuster account and a claimant account belong to the
same real person. When that link exists, `POST /adjuster/claims/{id}/decision`
refuses to let that adjuster decide on a claim filed by that same email — a
`403`, and the decision buttons don't even render on the claim page.

```bash
# An adjuster with no conflict of interest to worry about:
storage.create_adjuster("a.irving", "Adjuster Name")

# An adjuster who is also a claimant, so the conflict check applies:
storage.create_adjuster("a.irving", "Adjuster Name", linked_claimant_email="airving@gmail.com")
```

### Login audit trail

Every login and logout, on both sides, is appended to a `login_events` table
(`storage.record_login_event` / `storage.list_login_events`) — role
(`claimant`/`adjuster`), identifier (email or username), event
(`login`/`logout`), and a timestamp.

**Claimant login needs a real Google OAuth app** (Authlib needs a real client
ID/secret — there's no mock mode):

1. In [Google Cloud Console](https://console.cloud.google.com), create/select a
   project, then **APIs & Services → OAuth consent screen** → External, add
   scopes `openid`, `email`, `profile`, and add your own Google account under
   **Test users**.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   **Web application**. Under **Authorized redirect URIs**, add exactly:
   `http://127.0.0.1:8123/auth/google/callback`.
3. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` from that client, plus any random string for
   `SESSION_SECRET_KEY` (`python -c "import secrets; print(secrets.token_hex(32))"`).

**Adjuster login needs no external setup at all**:

```bash
.venv/Scripts/python.exe -c "import storage; storage.init_db(); print(storage.create_adjuster('a.irving', 'Adjuster Name'))"
```

### Run the web UI

```bash
.venv/Scripts/python.exe -m uvicorn app:app --reload --port 8123
```

Then open `http://127.0.0.1:8123/`.

### Test the web UI

```bash
.venv/Scripts/python.exe -m pytest tests/test_app.py -v
```

43 tests. No real Google login is needed — claimant login is faked with FastAPI's
`dependency_overrides` on `get_current_user`. Adjuster login is tested for real, not
faked — `storage.create_adjuster` generates a real account and the tests actually
`POST /adjuster/login` with the real password. Covers: separation of duties, the
login audit trail, mock extraction/summary/notifications, the "needs attention"
panel, strict route separation between the two roles (even for the exact same
claim), and input validation (oversized policy ID, future incident date,
disallowed file type, oversized file) being rejected with the form re-shown rather
than silently stored.

### UI tests (real browser, run on demand)

`tests/test_app.py` checks HTTP responses in-process and never touches a real
browser. `tests/test_ui.py` does, using Playwright against a real, live `uvicorn`
process it starts and stops itself (port 8199):

```bash
.venv/Scripts/python.exe -m playwright install chromium   # once
.venv/Scripts/python.exe -m pytest tests/test_ui.py -v
```

7 tests, including a regression test that measures the actual rendered WCAG
contrast ratio of the mock-card text against its background, rather than relying
on a human looking at a screenshot — a real bug slipped through exactly that way
once (the mock card's fixed cream background combined with the adjuster dark
theme's near-white text color measured 1.13:1 contrast before being fixed to
4.5:1+). Needs the fictional sample PDFs from the live repo's `sample_data/` to
run (not included in this submission snapshot).

### What's real vs. mocked

All seven Design Deliverable stages are wired into one pipeline — see `MOCKS.md`
for exactly which three are deliberately fake and why:

| Stage | Status |
|---|---|
| Completeness check | ✅ Real (the graded minimum) |
| Document/evidence storage | ✅ Real — `storage.py` writes uploaded files to `data/uploads/<claim_id>/` |
| Persistent claims database | ✅ Real — SQLite, survives a server restart |
| Accounts | ✅ Real — Google sign-in for claimants, provisioned username/password for adjusters |
| Fact extraction | 🟡 **Mock** — real text read (via `pypdf`), fake intelligence (plain regex) — see `MOCKS.md` |
| Summary generation | 🟡 **Mock** — template-assembled from stored fields, no model call — see `MOCKS.md` |
| Adjuster review | ✅ Real — a human decision, gated by separation of duties |
| Notifications | 🟡 **Mock** — logged on two channels, nothing actually sent — see `MOCKS.md` |

### Input validation and error handling

`validation.py` rejects malformed input before a claim is ever created —
separately from `main.py`'s completeness check, which only cares whether a
*complete* field is present, not whether a present one is well-formed. Limits:
policy ID ≤ 40 characters, description ≤ 5,000 characters, incident date can't
be in the future or before 2000, files must be one of
`.pdf .txt .jpg .jpeg .png .zip .doc .docx`, ≤ 10MB each, ≤ 10 files per claim.

Separately, a global exception handler (`app.py`'s `unhandled_error`) catches
anything that isn't already a handled response and returns a generic `500`
page — the real error goes to the server console, never into the response body.

### Claimant and adjuster pages are fully separate routes

Not just hidden behind role checks — there is no template and no URL that
renders differently depending on who's looking at it. Every claimant route
lives under `/`, `/claims`, `/notifications`; every adjuster route lives
under `/adjuster/...`. A claimant session grants zero access to any
`/adjuster/...` route, and an adjuster session grants zero access to
`/claims/{id}` — even for the exact same claim. The adjuster side also gets
its own visual theme (dark navy) specifically so the two never look alike
even at a glance.
