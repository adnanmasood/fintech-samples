"""Streamlit screen for the fraud screening demo. Decision rules live in logic.py."""
import json
from pathlib import Path

import streamlit as st

from logic import screen_transaction

SAMPLES = json.loads((Path(__file__).parent / "data" / "sample_transactions.json").read_text())
DEFAULTS = {"tid": "", "amount": 1000, "blocked": False, "score": "0.10", "timeout": False}


def load_sample():
    chosen = next((s for s in SAMPLES if s["name"] == st.session_state.sample), None)
    t = chosen["transaction"] if chosen else None
    values = DEFAULTS if t is None else {
        "tid": t["transaction_id"], "amount": t["amount_cents"],
        "blocked": t["card_blocked"], "timeout": t["model_timeout"],
        "score": "" if t["risk_score"] is None else str(t["risk_score"]),
    }
    st.session_state.update(values)


def parse_score(text):
    """Blank -> None (missing). Otherwise a float; unparseable text goes to logic as-is."""
    text = text.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return text


for key, value in DEFAULTS.items():
    st.session_state.setdefault(key, value)

st.title("Card Payment Fraud Screening")
st.caption("Fictional demo data only. No real model, no real cards.")

st.selectbox("Load a fictional sample", [s["name"] for s in SAMPLES], index=None,
             key="sample", on_change=load_sample, placeholder="Choose a sample (optional)")

with st.form("screen_form"):
    tid = st.text_input("Transaction ID", key="tid")
    amount = st.number_input("Amount (integer cents)", step=1, format="%d", key="amount")
    blocked = st.checkbox("Card is blocked", key="blocked")
    score_text = st.text_input(
        "Mock risk score (0 to 1, blank = missing)", key="score",
        help="A mock value for testing the rules. It is not a real fraud probability.")
    timeout = st.checkbox("Model timeout", key="timeout")
    submitted = st.form_submit_button("Screen transaction")

# Nothing is stored between runs: every result comes from the current input only.
if submitted:
    result = screen_transaction({
        "transaction_id": tid,
        "amount_cents": int(amount),
        "card_blocked": blocked,
        "risk_score": parse_score(score_text),
        "model_timeout": timeout,
    })

    if result["status"] == "INVALID_INPUT":
        st.error(f"Validation error: {result['reason']}. The request was not screened.")
    else:
        show = {"APPROVE": st.success, "CHALLENGE": st.warning, "DECLINE": st.error}
        show[result["status"]](f"{result['status']} / {result['reason']}")
        if result["status"] == "CHALLENGE":
            st.warning("Verification is required and has NOT yet succeeded. "
                       "The payment is not approved.")

    st.write(f"**Status:** {result['status']}")
    st.write(f"**Reason:** {result['reason']}")
    st.write(f"**Transaction ID:** {result['transaction_id']}")
    st.write(f"**Amount:** ${int(amount) / 100:,.2f} ({int(amount)} cents)")
    if timeout:
        st.write("**Mock risk score:** unavailable (model timeout)")
    else:
        st.write(f"**Mock risk score:** {score_text.strip() or 'missing'} "
                 "(mock value, not a real fraud probability)")
