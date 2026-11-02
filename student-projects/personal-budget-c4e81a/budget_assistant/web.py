"""Local web dashboard (Python standard library only).

Open http://127.0.0.1:8020 after `python -m budget_assistant serve`.

Demo sign-in: choose one of two fictional households. The server reads the
household from the cookie and passes it to every store call, so one household
can never see or correct the other's transactions. (A real deployment would
use proper authentication; see README limitations.)
"""
from __future__ import annotations

import html
from email.parser import BytesParser
from email.policy import default as email_policy
from http.cookies import SimpleCookie
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from .money import format_cents
from .rules import DEFAULT_RULES, UNCATEGORIZED
from .service import import_csv, load_budgets, user_report
from .store import AccessError, JsonStore

DEMO_USERS = ("household-a", "household-b")
SAMPLE_DIR = Path(__file__).resolve().parent.parent / "data"
CATEGORIES = sorted({c for _, c in DEFAULT_RULES} | {"Shopping", "Other"})
e = html.escape
_LOCK = threading.Lock()  # one request touches the JSON store at a time

CSS = """
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d2321;--mute:#66706b;--line:#e3e1da;
--accent:#1f6f5c;--warn:#b26a00;--bad:#b3261e;--ok:#2e7d32;--chip:#eef4f1}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
background:var(--bg);color:var(--ink)}
header{background:var(--ink);color:#fff;padding:14px 24px;display:flex;gap:16px;align-items:center}
header h1{font-size:18px;margin:0;font-weight:650}header .who{margin-left:auto;font-size:13px;opacity:.85}
header a{color:#cfe8df}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card h2{font-size:15px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.grid2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mute);font-weight:600;font-size:12px;text-transform:uppercase}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:2px solid var(--ink)}
.kpis{display:flex;gap:12px;flex-wrap:wrap}
.kpi{flex:1;min-width:150px;background:var(--chip);border-radius:8px;padding:10px 12px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{font-size:12px;color:var(--mute)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.OK{background:#e6f2e7;color:var(--ok)}.NEAR_LIMIT{background:#fff3e0;color:var(--warn)}
.OVER{background:#fdeceb;color:var(--bad)}
.src{font-size:12px;color:var(--mute)}
.alert{border-left:4px solid var(--bad);background:#fdf3f2}
.alert li{margin:2px 0}
.notice{border-left:4px solid var(--accent);background:#eef6f3}
.insight{border-left:4px solid var(--accent)}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;min-width:80px}
.bar i{display:block;height:100%;background:var(--accent)}.bar i.OVER{background:var(--bad)}
.bar i.NEAR_LIMIT{background:var(--warn)}
button,select,input[type=file]{font:inherit}button{background:var(--accent);color:#fff;border:0;
border-radius:6px;padding:6px 12px;cursor:pointer}button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
form.inline{display:flex;gap:6px;align-items:center;margin:0}
.review{background:#fff8ec}
"""


def page(title: str, body: str, user: str | None = None) -> bytes:
    who = (f'<span class="who">Signed in as <b>{e(user)}</b> (fictional) · '
           f'<a href="/logout">switch</a></span>' if user else "")
    return (f"<!doctype html><html><head><meta charset=utf-8>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{e(title)}</title><style>{CSS}</style></head><body>"
            f"<header><h1>Personal Budget Assistant</h1>{who}</header>"
            f"<main>{body}</main></body></html>").encode()


class Handler(BaseHTTPRequestHandler):
    store: JsonStore
    budgets: dict

    def log_message(self, *a):  # keep the terminal quiet
        pass

    # ---------- helpers ----------
    def _user(self) -> str | None:
        c = SimpleCookie(self.headers.get("Cookie", ""))
        u = c["user"].value if "user" in c else None
        return u if u in DEMO_USERS else None

    def _send(self, body: bytes, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, to: str, cookie: str | None = None):
        h = {"Location": to}
        if cookie is not None:
            h["Set-Cookie"] = cookie
        self._send(b"", 303, h)

    def _form(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        ctype = self.headers.get("Content-Type", "")
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_policy).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
            out = {}
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                out[name] = (part.get_filename(), part.get_payload(decode=True) or b"")
            return out
        return {k: v[0] for k, v in parse_qs(raw.decode()).items()}

    # ---------- routes ----------
    def do_GET(self):
        with _LOCK:
            self._get()

    def do_POST(self):
        with _LOCK:
            self._post()

    def _get(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/login":
            u = q.get("user")
            if u in DEMO_USERS:
                return self._redirect("/", f"user={u}; Path=/; HttpOnly; SameSite=Lax")
            return self._redirect("/")
        if url.path == "/logout":
            return self._redirect("/", "user=; Path=/; Max-Age=0")
        if url.path != "/":
            return self._send(page("Not found", "<div class=card>Not found</div>"), 404)
        user = self._user()
        if not user:
            return self._send(page("Sign in", self._login_html()))
        return self._send(page("Dashboard", self._dashboard(user, q), user))

    def _post(self):
        user = self._user()
        if not user:  # server-side check: no household, no data access
            return self._send(page("Sign in", self._login_html()), 401)
        path = urlparse(self.path).path
        f = self._form()
        if path == "/upload":
            name, data = f.get("file", (None, b""))
            if f.get("sample"):
                sample = f["sample"][1].decode() if isinstance(f["sample"], tuple) else f["sample"]
                if sample in ("sample_transactions.csv", "repeat_import.csv"):
                    name, data = sample, (SAMPLE_DIR / sample).read_bytes()
            if not data:
                return self._redirect("/?msg=" + quote("Choose a CSV file first."))
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                return self._redirect("/?err=" + quote("File is not UTF-8 text CSV."))
            s = import_csv(self.store, user, text, name or "upload")
            if s.parsed.header_error:
                return self._redirect("/?err=" + quote(s.parsed.header_error))
            st = s.stored
            msg = (f"Imported {name}: {len(st.added)} added, "
                   f"{len(st.already_imported)} already imported (skipped), "
                   f"{len(s.parsed.errors)} rejected, {len(st.conflicts)} conflicting IDs.")
            return self._redirect("/?msg=" + quote(msg))
        if path == "/correct":
            tid, cat = f.get("txn_id", ""), f.get("category", "")
            txns = {t.txn_id: t for t in self.store.transactions(user)}
            try:
                self.store.set_override(user, tid, cat)
            except (AccessError, ValueError) as ex:
                return self._redirect("/?err=" + quote(str(ex.args[0])))
            if f.get("merchant_rule") == "on":
                self.store.set_merchant_rule(user, txns[tid].description, cat)
            return self._redirect("/?msg=" + quote(f"Saved: {tid} is now {cat}."))
        if path == "/reset":
            self.store.clear_user(user)
            return self._redirect("/?msg=" + quote("Your demo data was cleared."))
        self._send(page("Not found", "<div class=card>Not found</div>"), 404)

    # ---------- views ----------
    def _login_html(self) -> str:
        links = " ".join(f'<a href="/login?user={u}"><button>{u}</button></a>' for u in DEMO_USERS)
        return (f"<div class=card><h2>Choose a fictional household</h2>"
                f"<p>Each household's data is stored separately. {links}</p></div>")

    def _dashboard(self, user: str, q: dict) -> str:
        report, decisions, (insight, isrc, _) = user_report(self.store, user, self.budgets)
        txns = self.store.transactions(user)
        parts = []
        if q.get("msg"):
            parts.append(f"<div class='card notice'>{e(q['msg'])}</div>")
        if q.get("err"):
            parts.append(f"<div class='card alert'><b>Error:</b> {e(q['err'])}</div>")

        parts.append(
            "<div class=card><h2>Import transactions (CSV)</h2>"
            "<form class=inline method=post action=/upload enctype=multipart/form-data>"
            "<input type=file name=file accept='.csv,text/csv'><button>Upload</button></form>"
            "<p class=src style='margin:8px 0 0'>Or load fictional sample: "
            "<form class=inline style='display:inline' method=post action=/upload "
            "enctype=multipart/form-data><input type=hidden name=sample "
            "value=sample_transactions.csv><button class=ghost>sample_transactions.csv</button></form> "
            "<form class=inline style='display:inline' method=post action=/reset>"
            "<button class=ghost>Clear my data</button></form></p></div>")

        if report.row_errors:
            items = "".join(f"<li>{e(m)}</li>" for m in report.row_errors)
            parts.append(f"<div class='card alert'><h2>Rejected rows from last import "
                         f"({len(report.row_errors)}) — not in any total</h2><ul>{items}</ul></div>")

        if not txns:
            parts.append("<div class=card>No transactions yet. Upload a CSV or load the sample.</div>")
            return "".join(parts)

        parts.append(
            f"<div class=card><h2>Summary · {report.period_start} to {report.period_end} · "
            f"coverage {report.coverage}</h2><div class=kpis>"
            f"<div class=kpi><span>Net spending</span><b>{format_cents(report.net_spending_cents)}</b></div>"
            f"<div class=kpi><span>Income (not spending)</span><b>{format_cents(report.income_cents)}</b></div>"
            f"<div class=kpi><span>Income − spending</span><b>{format_cents(report.income_minus_spending_cents)}</b>"
            f"<span>not an account balance</span></div>"
            f"<div class=kpi><span>Needs review</span><b>{len(report.uncategorized_ids)}</b></div>"
            f"</div></div>")

        parts.append(f"<div class='card insight'><h2>Insight <span class=src>({e(isrc)})</span></h2>"
                     f"<p style='margin:0'>{e(insight)}</p></div>")

        cat_rows = "".join(f"<tr><td>{e(c)}</td><td class=num>{format_cents(v)}</td></tr>"
                           for c, v in report.category_totals.items())
        excluded = (f"<tr><td colspan=2 class=src style='padding-top:12px'>Not counted as spending</td></tr>"
                    f"<tr><td>Own-account transfers</td><td class=num>{format_cents(report.transfers_cents)}</td></tr>"
                    f"<tr><td>Card bill payments</td><td class=num>{format_cents(report.card_payments_cents)}</td></tr>")
        cats = (f"<div class=card><h2>Spending by category</h2><table><tr><th>Category</th>"
                f"<th class=num>Net</th></tr>{cat_rows}<tr class=total><td>Net spending</td>"
                f"<td class=num>{format_cents(report.net_spending_cents)}</td></tr>{excluded}</table></div>")
        brow = ""
        for b in report.budget_lines:
            w = min(float(b.pct_used or 0), 100)
            brow += (f"<tr><td>{e(b.category)}</td><td class=num>{format_cents(b.budget_cents)}</td>"
                     f"<td class=num>{format_cents(b.spent_cents)}</td>"
                     f"<td class=num>{format_cents(b.remaining_cents)}</td>"
                     f"<td><div class=bar><i class={b.status} style='width:{w}%'></i></div></td>"
                     f"<td class=num>{b.pct_used}%</td><td><span class='badge {b.status}'>{b.status}</span></td></tr>")
        buds = (f"<div class=card><h2>Budgets</h2><table><tr><th>Category</th><th class=num>Budget</th>"
                f"<th class=num>Spent</th><th class=num>Left</th><th></th><th class=num>Used</th>"
                f"<th>Status</th></tr>{brow}</table></div>")
        parts.append(f"<div class=grid2>{cats}{buds}</div>")

        rows = ""
        for t in txns:
            d = decisions[t.txn_id]
            sign = "−" if t.txn_type == "refund" else ""
            fix = ""
            if t.is_spending:
                opts = "".join(
                    f"<option{' selected' if c == d.category else ''}>{e(c)}</option>"
                    for c in CATEGORIES)
                fix = (f"<form class=inline method=post action=/correct>"
                       f"<input type=hidden name=txn_id value='{e(t.txn_id)}'>"
                       f"<select name=category>{opts}</select>"
                       f"<label class=src><input type=checkbox name=merchant_rule> always</label>"
                       f"<button class=ghost>Fix</button></form>")
            cls = " class=review" if d.category == UNCATEGORIZED else ""
            rows += (f"<tr{cls}><td>{e(t.txn_id)}</td><td>{t.date}</td><td>{e(t.description)}</td>"
                     f"<td>{e(t.txn_type)}</td><td class=num>{sign}{format_cents(t.amount_cents)}</td>"
                     f"<td>{e(d.category)}<div class=src>{e(d.source)}: {e(d.detail)}</div></td>"
                     f"<td>{fix}</td></tr>")
        parts.append(f"<div class=card><h2>Transactions ({len(txns)})</h2><table><tr><th>ID</th>"
                     f"<th>Date</th><th>Description</th><th>Type</th><th class=num>Amount</th>"
                     f"<th>Category (why)</th><th>Correct</th></tr>{rows}</table></div>")
        return "".join(parts)


def serve(port: int, store_path: str, budgets_path: str) -> None:
    Handler.store = JsonStore(store_path)
    Handler.budgets = load_budgets(budgets_path)
    # Threaded so a browser's idle pre-opened connection cannot block the page;
    # _LOCK keeps store access one request at a time.
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Personal Budget Assistant running at http://127.0.0.1:{port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
