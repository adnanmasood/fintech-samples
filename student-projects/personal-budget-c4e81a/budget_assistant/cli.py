"""Command-line interface.

  python -m budget_assistant report data/sample_transactions.csv
  python -m budget_assistant import data/sample_transactions.csv --user household-a
  python -m budget_assistant show --user household-a
  python -m budget_assistant correct T2 Dining --user household-a
  python -m budget_assistant serve
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from .money import format_cents
from .service import import_csv, load_budgets, user_report
from .store import AccessError, JsonStore

HERE = Path(__file__).resolve().parent.parent
DEFAULT_BUDGETS = HERE / "data" / "budgets.json"
DEFAULT_STORE = HERE / "var" / "store.json"


def render_text(report, decisions, explanation) -> str:
    out = []
    period = (f"{report.period_start} to {report.period_end}"
              if report.period_start else "no data")
    out.append(f"PERIOD: {period}   COVERAGE: {report.coverage}"
               + (f" ({report.coverage_note})" if report.coverage_note else ""))
    out.append("")
    out.append("SPENDING BY CATEGORY")
    for cat, cents in report.category_totals.items():
        out.append(f"  {cat:<16}{format_cents(cents):>12}")
    out.append(f"  {'NET SPENDING':<16}{format_cents(report.net_spending_cents):>12}")
    out.append("")
    out.append("NOT COUNTED AS SPENDING")
    out.append(f"  {'Income':<16}{format_cents(report.income_cents):>12}")
    out.append(f"  {'Own transfers':<16}{format_cents(report.transfers_cents):>12}")
    out.append(f"  {'Card payments':<16}{format_cents(report.card_payments_cents):>12}")
    out.append(f"  Income minus net spending: {format_cents(report.income_minus_spending_cents)}"
               " (not an account balance)")
    if report.budget_lines:
        out.append("")
        out.append("BUDGETS")
        for b in report.budget_lines:
            pct = f"{b.pct_used}%" if b.pct_used is not None else "n/a"
            out.append(f"  {b.category:<14} budget {format_cents(b.budget_cents):>10}  "
                       f"spent {format_cents(b.spent_cents):>10}  "
                       f"left {format_cents(b.remaining_cents):>10}  {pct:>7}  {b.status}")
    if report.uncategorized_ids:
        out.append("")
        out.append("NEEDS REVIEW (uncategorized): " + ", ".join(report.uncategorized_ids))
    if report.row_errors:
        out.append("")
        out.append(f"REJECTED ROWS ({len(report.row_errors)}) - not included in totals")
        for e in report.row_errors:
            out.append("  " + (e if isinstance(e, str) else e.message()))
    out.append("")
    text, source, issues = explanation
    out.append(f"INSIGHT [{source}]: {text}")
    for i in issues:
        out.append(f"  (generated text rejected: {i})")
    return "\n".join(out)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="budget_assistant")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, store=True):
        sp.add_argument("--budgets", default=str(DEFAULT_BUDGETS))
        if store:
            sp.add_argument("--store", default=str(DEFAULT_STORE))
            sp.add_argument("--user", default="household-a")
        sp.add_argument("--partial", metavar="NOTE",
                        help="mark coverage PARTIAL with an explanation")

    r = sub.add_parser("report", help="one-shot report for a CSV (nothing saved)")
    r.add_argument("csv")
    common(r, store=False)
    i = sub.add_parser("import", help="import a CSV into the saved store")
    i.add_argument("csv")
    common(i)
    s = sub.add_parser("show", help="report on saved data")
    common(s)
    c = sub.add_parser("correct", help="override one transaction's category")
    c.add_argument("txn_id")
    c.add_argument("category")
    c.add_argument("--merchant-rule", action="store_true",
                   help="also apply to this user's future transactions from this merchant")
    common(c)
    sv = sub.add_parser("serve", help="start the local web dashboard")
    sv.add_argument("--port", type=int, default=8020)
    sv.add_argument("--store", default=str(DEFAULT_STORE))
    sv.add_argument("--budgets", default=str(DEFAULT_BUDGETS))

    a = p.parse_args(argv)

    if a.cmd == "serve":
        from .web import serve
        serve(a.port, a.store, a.budgets)
        return 0

    budgets = load_budgets(a.budgets)
    cov = ("PARTIAL", a.partial) if a.partial else ("COMPLETE", "")

    if a.cmd == "report":
        with tempfile.TemporaryDirectory() as d:
            store = JsonStore(Path(d) / "s.json")
            summary = import_csv(store, "cli", Path(a.csv).read_text(encoding="utf-8"), a.csv)
            if summary.parsed.header_error:
                print("ERROR: " + summary.parsed.header_error, file=sys.stderr)
                return 2
            print(render_text(*user_report(store, "cli", budgets, *cov)))
        return 0

    store = JsonStore(a.store)
    if a.cmd == "import":
        summary = import_csv(store, a.user, Path(a.csv).read_text(encoding="utf-8"), a.csv)
        if summary.parsed.header_error:
            print("ERROR: " + summary.parsed.header_error, file=sys.stderr)
            return 2
        st = summary.stored
        print(f"Added {len(st.added)}, already imported {len(st.already_imported)}, "
              f"conflicting IDs {len(st.conflicts)}, rejected rows {len(summary.parsed.errors)}")
        for e in summary.parsed.errors:
            print("  " + e.message())
        for cid in st.conflicts:
            print(f"  CONFLICT: {cid} was imported before with different data; not changed")
        return 0
    if a.cmd == "correct":
        txns = {t.txn_id: t for t in store.transactions(a.user)}
        try:
            store.set_override(a.user, a.txn_id, a.category)
        except AccessError as e:
            print("ERROR: " + str(e.args[0]), file=sys.stderr)
            return 3
        if a.merchant_rule:
            store.set_merchant_rule(a.user, txns[a.txn_id].description, a.category)
        print(f"{a.txn_id} -> {a.category} saved.")
    print(render_text(*user_report(store, a.user, budgets, *cov)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
