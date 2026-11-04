import html

import streamlit as st

import auth
from logic import WALLETS, new_state, total_funds, transfer

st.set_page_config(page_title="Digital Wallet Transfer (Mock)", page_icon="💸", layout="centered")

STYLE = """
<style>
.block-container { max-width: 760px; padding-top: 2.5rem; }
.hero h1 { margin: 0; font-size: 2rem; letter-spacing: -0.02em; }
.hero p { margin: .25rem 0 1.25rem; opacity: .65; font-size: .95rem; }
.balance-card {
    border: 1px solid rgba(128,128,128,.28); border-radius: 14px;
    padding: 16px 18px; background: rgba(128,128,128,.07);
}
.balance-card .label { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
.balance-card .value { font-size: 1.7rem; font-weight: 650; margin-top: 2px; }
.balance-card.total { background: linear-gradient(135deg, #1e3a8a, #2563eb); border: none; color: #fff; }
.balance-card.total .label { opacity: .8; }
.receipt {
    background: #ffffff; color: #1f2937; border-radius: 14px; padding: 26px 28px 22px;
    box-shadow: 0 6px 24px rgba(0,0,0,.18); border-top: 6px solid #16a34a;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
.receipt.original { border-top-color: #d97706; }
.receipt .brand { font-weight: 700; font-size: .8rem; letter-spacing: .12em; color: #6b7280; text-transform: uppercase; }
.receipt .headline { font-size: 1.15rem; font-weight: 650; margin: 6px 0 2px; }
.receipt .amount { font-size: 2.4rem; font-weight: 750; letter-spacing: -0.02em; margin: 4px 0 14px; }
.receipt .badge {
    display: inline-block; font-size: .72rem; font-weight: 700; letter-spacing: .06em;
    padding: 3px 10px; border-radius: 999px; background: #dcfce7; color: #166534;
}
.receipt.original .badge { background: #fef3c7; color: #92400e; }
.receipt table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.receipt td { padding: 9px 0; border-top: 1px dashed #d1d5db; font-size: .93rem; vertical-align: top; }
.receipt td.k { color: #6b7280; width: 46%; }
.receipt td.v { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.receipt .foot { margin-top: 14px; padding-top: 12px; border-top: 2px solid #e5e7eb;
    font-size: .75rem; color: #9ca3af; text-align: center; }
</style>
"""

# Initialize once; reruns from widget changes keep existing values.
if "wallet_state" not in st.session_state:
    st.session_state.wallet_state = new_state()
    st.session_state.last_result = None


def money(cents):
    return f"${cents / 100:,.2f}"


def reset_demo():
    st.session_state.wallet_state = new_state()
    st.session_state.last_result = None


def balance_card(label, value, extra_class=""):
    return (f'<div class="balance-card {extra_class}"><div class="label">{html.escape(label)}</div>'
            f'<div class="value">{html.escape(value)}</div></div>')


def receipt_html(receipt, is_original):
    e = html.escape
    rows = [
        ("Reference", receipt["request_id"]),
        ("From", f"Wallet {receipt['sender']}"),
        ("To", f"Wallet {receipt['recipient']}"),
        ("Currency", receipt["currency"]),
        (f"Wallet {receipt['sender']} balance after", money(receipt["balances_after"][receipt["sender"]])),
        (f"Wallet {receipt['recipient']} balance after", money(receipt["balances_after"][receipt["recipient"]])),
    ]
    body = "".join(f'<tr><td class="k">{e(k)}</td><td class="v">{e(v)}</td></tr>' for k, v in rows)
    headline = "Original receipt (request already completed)" if is_original else "Transfer receipt"
    badge = "ALREADY PROCESSED" if is_original else "COMPLETED"
    return (
        f'<div class="receipt{" original" if is_original else ""}">'
        f'<div class="brand">Digital Wallet &middot; Mock</div>'
        f'<div class="headline">{e(headline)} <span class="badge">{badge}</span></div>'
        f'<div class="amount">{e(money(receipt["amount_cents"]))}</div>'
        f'<table>{body}</table>'
        f'<div class="foot">Fictional money. No real accounts were used.</div>'
        f'</div>'
    )


st.markdown(STYLE, unsafe_allow_html=True)
st.markdown(
    '<div class="hero"><h1>💸 Send money</h1>'
    '<p>Move funds between wallets. Mock data only: fictional wallets and fictional money.</p></div>',
    unsafe_allow_html=True,
)

MAX_FAILED_SIGN_INS = 5

if "signed_in_wallet" not in st.session_state:
    st.session_state.signed_in_wallet = None
    st.session_state.signed_in_user = None
    st.session_state.failed_sign_ins = 0

if st.session_state.signed_in_wallet is None:
    auth.ensure_demo_account()
    st.subheader("Sign in")
    st.caption("Sign in as the Wallet A owner to send money.")
    locked = st.session_state.failed_sign_ins >= MAX_FAILED_SIGN_INS
    if locked:
        st.error("Too many failed attempts. Reload the page to try again.")
    with st.form("login_form", border=True):
        user = st.text_input("Username", autocomplete="username")
        password = st.text_input("Password", type="password", autocomplete="current-password")
        signed = st.form_submit_button("Sign in", type="primary", use_container_width=True,
                                       disabled=locked)
    if signed:
        wallet = auth.verify_login(user, password)
        if wallet:
            st.session_state.signed_in_wallet = wallet
            st.session_state.signed_in_user = user.strip()
            st.session_state.failed_sign_ins = 0
            st.rerun()
        else:
            st.session_state.failed_sign_ins += 1
            st.error("Incorrect username or password.")
    st.caption("Demo credentials (copy and paste into the fields above):")
    st.code(auth.DEMO_USERNAME, language=None)
    st.code(auth.DEMO_PASSWORD, language=None)
    st.stop()

signed_in_wallet = st.session_state.signed_in_wallet
bar_text, bar_btn = st.columns([4, 1])
bar_text.caption(f"Signed in as **{st.session_state.signed_in_user}** (Wallet {signed_in_wallet} owner)")
if bar_btn.button("Sign out"):
    st.session_state.signed_in_wallet = None
    st.session_state.signed_in_user = None
    st.rerun()

balances = st.session_state.wallet_state["balances"]
cols = st.columns(3)
for col, wallet in zip(cols, WALLETS):
    col.markdown(balance_card(f"Wallet {wallet} (mock)", money(balances[wallet])), unsafe_allow_html=True)
cols[2].markdown(
    balance_card("Total funds (mock)", money(total_funds(st.session_state.wallet_state)), "total"),
    unsafe_allow_html=True,
)

st.write("")
with st.form("transfer_form", border=True):
    st.markdown("**New transfer**")
    request_id = st.text_input("Request ID", value="R001", help="Reusing an ID with the same details is safe.")
    c1, c2 = st.columns(2)
    sender = c1.selectbox("From", WALLETS, index=WALLETS.index(signed_in_wallet), disabled=True,
                          help="You can only send from the wallet you signed in to.")
    recipient = c2.selectbox("To", WALLETS, index=1)
    c3, c4 = st.columns([3, 1])
    amount = c3.number_input("Amount (USD cents, mock)", min_value=-1_000_000,
                             max_value=1_000_000, value=5000, step=100,
                             help="Whole cents. 100 cents = $1.00, so 5000 cents = $50.00.")
    currency = c4.selectbox("Currency", ["USD"])
    submitted = st.form_submit_button("Send transfer", type="primary", use_container_width=True)

if submitted:
    request = {"request_id": request_id, "sender": signed_in_wallet, "recipient": recipient,
               "amount_cents": int(amount), "currency": currency}
    st.session_state.last_before = dict(st.session_state.wallet_state["balances"])
    new, result = transfer(st.session_state.wallet_state, request)
    st.session_state.wallet_state = new
    st.session_state.last_result = result
    st.rerun()

result = st.session_state.last_result
if result is not None:
    st.write("")
    text = f"**{result['status']}**: {result['reason']} (Request ID: {result['request_id'] or 'blank'})"
    if result["status"] == "COMPLETED":
        st.success(text, icon="✅")
    elif result["status"] == "DUPLICATE_REQUEST":
        st.warning(text, icon="⚠️")
    else:
        st.error(text, icon="🚫")
    before = st.session_state.last_before
    now = st.session_state.wallet_state

    def md_money(cents):  # escape $ so Streamlit does not read $...$ as math
        return money(cents).replace("$", "\\$")

    st.markdown(
        f"**Before:** A {md_money(before['A'])} | B {md_money(before['B'])} &nbsp;→&nbsp; "
        f"**After:** A {md_money(now['balances']['A'])} | B {md_money(now['balances']['B'])} "
        f"&nbsp;·&nbsp; **Total funds:** {md_money(total_funds(now))}"
    )
    receipt = result.get("receipt") or result.get("original_receipt")
    if receipt:
        st.markdown(receipt_html(receipt, "original_receipt" in result), unsafe_allow_html=True)

st.write("")
st.button("Reset demo", on_click=reset_demo)
