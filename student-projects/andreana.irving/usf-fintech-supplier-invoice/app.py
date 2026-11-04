"""Streamlit screen for the Supplier Invoice Approval System.

Fictional classroom data only — no model API, no database. This file only
collects form input and displays results; every validation and duplicate
rule lives in logic.py and is called from here, never reimplemented.
"""
import streamlit as st

from logic import (
    STATUS_DUPLICATE,
    STATUS_INVALID,
    STATUS_PENDING,
    check_invoice,
    duplicate_explanation,
)

st.set_page_config(
    page_title="Invoice Duplicate Checker", page_icon="🧾", layout="wide"
)


def _format_dollars(amount_cents):
    return f"${amount_cents / 100:,.2f}"


def _escape_markdown_dollar(formatted_amount):
    """Escape a literal "$" for text passed to st.write/st.success/
    st.warning/st.error. Streamlit renders those as Markdown, where a
    pair of "$" is parsed as inline LaTeX math instead of a currency
    sign — harmless with one "$" in a string, but a second one later in
    the same string pairs with it and both the signs and the text
    between them render wrong. Not used for st.dataframe, which shows
    plain text and does not parse Markdown."""
    return formatted_amount.replace("$", "\\$")


def _format_signed_dollars(amount_cents):
    sign = "+" if amount_cents > 0 else "-" if amount_cents < 0 else ""
    return f"{sign}${abs(amount_cents) / 100:,.2f}"


def _reset_demo():
    st.session_state["invoices"] = {}
    st.session_state["last_result"] = None
    st.session_state["last_submitted_amount_cents"] = None
    st.session_state["last_submitted_filename"] = None


# --- session state: initialize once, keep across reruns until Reset ---
if "invoices" not in st.session_state:
    st.session_state["invoices"] = {}
if "last_result" not in st.session_state:
    st.session_state["last_result"] = None
if "last_submitted_amount_cents" not in st.session_state:
    st.session_state["last_submitted_amount_cents"] = None
if "last_submitted_filename" not in st.session_state:
    st.session_state["last_submitted_filename"] = None

st.title("Invoice Duplicate Checker")
st.caption("Built by Andreana Irving · USF AI in FinTech · Fictional data")

with st.expander("How it works", expanded=False):
    st.write(
        "Duplicates are detected by supplier ID plus invoice number, never by "
        "filename or amount. A PENDING_APPROVAL record is not approval to pay — "
        "an AP reviewer still has to approve it."
    )

input_col, result_col = st.columns(2)

with input_col:
    with st.container(border=True):
        st.subheader("Inputs")
        with st.form("invoice_form", clear_on_submit=False, border=False):
            supplier_id = st.text_input("Supplier ID", placeholder="S01")
            invoice_number = st.text_input("Invoice number", placeholder="INV-101")
            amount_cents = st.number_input(
                "Amount in cents",
                min_value=-1_000_000_000,
                max_value=1_000_000_000,
                value=0,
                step=1,
                format="%d",
                help="Fictional amount in USD cents, e.g. 100000 = $1,000.00.",
            )
            filename = st.text_input(
                "Mock filename (optional)",
                placeholder="invoice_101.json",
                help="Fictional label only — never used as part of the duplicate key.",
            )
            submitted = st.form_submit_button("Check invoice", type="primary")

        st.button(
            "Reset demo",
            on_click=_reset_demo,
            type="secondary",
            use_container_width=True,
        )

    if submitted:
        invoice = {
            "supplier_id": supplier_id,
            "invoice_number": invoice_number,
            "amount_cents": int(amount_cents),
            "filename": filename or None,
        }
        new_records, result = check_invoice(st.session_state["invoices"], invoice)
        st.session_state["invoices"] = new_records
        st.session_state["last_result"] = result
        st.session_state["last_submitted_amount_cents"] = invoice["amount_cents"]
        st.session_state["last_submitted_filename"] = invoice["filename"]

with result_col:
    with st.container(border=True):
        st.subheader("Result")
        result = st.session_state["last_result"]

        if result is None:
            st.caption("Submit the form to check an invoice.")
        elif result["status"] == STATUS_PENDING:
            record = result["invoice"]
            st.success(f"**{STATUS_PENDING}**")
            st.write(
                f"New invoice recorded. Key: {record['supplier_id']} / "
                f"{record['invoice_number']}. Pending record count: "
                f"{len(st.session_state['invoices'])}. Amount: "
                f"{_escape_markdown_dollar(_format_dollars(record['amount_cents']))}."
            )
            st.write("This invoice is awaiting AP reviewer approval and has not been approved or paid.")
            st.caption("No payment request has been authorized.")
        elif result["status"] == STATUS_DUPLICATE:
            existing = result["existing_invoice"]
            submitted_amount = st.session_state["last_submitted_amount_cents"]
            submitted_filename = st.session_state["last_submitted_filename"]
            st.warning(f"**{STATUS_DUPLICATE}**")
            st.write(
                f"Existing {existing['supplier_id']} / {existing['invoice_number']} "
                f"found. Count remains {len(st.session_state['invoices'])}. "
                f"Stored amount remains {_escape_markdown_dollar(_format_dollars(existing['amount_cents']))}."
            )
            st.write(
                f"You submitted {_escape_markdown_dollar(_format_dollars(submitted_amount))} "
                f"(filename: {submitted_filename or '—'}) this time; it was not stored."
            )
            explanation = duplicate_explanation(existing, {"amount_cents": submitted_amount})
            st.markdown("**Duplicate explanation**")
            original_md = _escape_markdown_dollar(_format_dollars(explanation["original_amount_cents"]))
            submitted_md = _escape_markdown_dollar(_format_dollars(explanation["submitted_amount_cents"]))
            difference_md = _escape_markdown_dollar(_format_signed_dollars(explanation["difference_cents"]))
            st.write(
                f"Original stored: {original_md} | "
                f"Newly submitted: {submitted_md} | "
                f"Difference: {difference_md}"
            )
            st.caption("Changed amount or filename does not create a new obligation.")
        else:  # STATUS_INVALID
            st.error(f"**{STATUS_INVALID}**")
            st.write(result["reason"])
            st.caption("No record was created or changed.")

st.divider()

with st.container(border=True):
    st.subheader("Pending Invoices")
    count_col, table_col = st.columns([1, 3])
    with count_col:
        st.metric("Pending record count", len(st.session_state["invoices"]))

    with table_col:
        st.caption("Accepted invoices (fictional data)")
        records = st.session_state["invoices"]
        if records:
            rows = [
                {
                    "Supplier ID": record["supplier_id"],
                    "Invoice number": record["invoice_number"],
                    "Amount": _format_dollars(record["amount_cents"]),
                    "Status": record["status"],
                    "Mock filename": record["filename"] or "—",
                }
                for key, record in sorted(records.items())
            ]
            st.dataframe(rows, use_container_width=True, hide_index=True)
        else:
            st.write("No accepted invoices yet.")
