"""Meridian Bank | Onboarding Review Console (Streamlit screen layer).

Fictional classroom prototype for USF AI in FinTech. This file only collects inputs,
calls logic.check_onboarding, and displays the result. All rules live in logic.py.

Run:  .venv/bin/python -m streamlit run app.py
"""

import html
import json
from pathlib import Path

import streamlit as st

from logic import (
    READY,
    REASON_TEXT,
    check_onboarding,
    comparison_checklist,
    outcome_category,
)

DATA_FILE = Path(__file__).parent / "data" / "examples.json"
FIELD_KEYS = ("s_name", "s_dob", "i_name", "i_dob")

st.set_page_config(
    page_title="Meridian Bank | Onboarding Review",
    page_icon="🏦",
    layout="wide",
    initial_sidebar_state="collapsed",
)


# --------------------------------------------------------------------------- helpers
@st.cache_data
def load_examples() -> dict:
    with open(DATA_FILE, encoding="utf-8") as fh:
        return json.load(fh)["scenarios"]


def block(markup: str) -> None:
    """Render HTML. Lines are left-stripped so Markdown never treats them as code."""
    st.markdown("\n".join(line.strip() for line in markup.splitlines()), unsafe_allow_html=True)


def esc(value) -> str:
    return html.escape("" if value is None else str(value))


def shown_raw(value) -> str:
    """Show the original string exactly, with quotes so leading/trailing spaces are visible."""
    if value is None or value == "" or value == "(blank)":
        return '<span class="blank">(blank)</span>'
    return f'<span class="raw">"{esc(value)}"</span>'


def init_state() -> None:
    st.session_state.setdefault("screen", "home")
    st.session_state.setdefault("field_values", {k: "" for k in FIELD_KEYS})
    st.session_state.setdefault("record", None)  # latest submitted records only
    st.session_state.setdefault("result", None)  # latest result only (stateless checker)
    st.session_state.setdefault("scenario_label", "Manual entry")


def values_from_case(case: dict) -> dict:
    return {
        "s_name": case["signup"]["full_name"],
        "s_dob": case["signup"]["date_of_birth"],
        "i_name": case["extracted_id"]["full_name"],
        "i_dob": case["extracted_id"]["date_of_birth"],
    }


def go_to_form(values: dict | None = None, label: str | None = None) -> None:
    """Callback: open the application form, pre-filling the widget keys."""
    if values is not None:
        st.session_state["field_values"] = dict(values)
    if label is not None:
        st.session_state.scenario_label = label
    for key in FIELD_KEYS:
        st.session_state[key] = st.session_state["field_values"].get(key, "")
    st.session_state.screen = "form"


def fill_example(values: dict, label: str) -> None:
    """Callback for example buttons on the form screen."""
    st.session_state["field_values"] = dict(values)
    st.session_state.scenario_label = label
    for key in FIELD_KEYS:
        st.session_state[key] = values[key]


def set_id_name(value: str, label: str) -> None:
    """Small modification: fill only the mock ID name (e.g. ' DANA LEE ')."""
    st.session_state["i_name"] = value
    st.session_state.scenario_label = label


def go_home() -> None:
    st.session_state.screen = "home"


def run_scenario(case: dict, label: str) -> None:
    """Callback: run a saved scenario end-to-end and jump straight to its result screen."""
    vals = values_from_case(case)
    st.session_state["field_values"] = vals
    st.session_state.scenario_label = label
    submit_record(vals)


def submit_record(vals: dict) -> None:
    signup = {"full_name": vals["s_name"], "date_of_birth": vals["s_dob"]}
    extracted_id = {"full_name": vals["i_name"], "date_of_birth": vals["i_dob"]}
    st.session_state.record = {"signup": signup, "extracted_id": extracted_id}
    st.session_state.result = check_onboarding(signup, extracted_id)
    st.session_state.screen = "result"


# --------------------------------------------------------------------------- styling
CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap');
:root{
--navy:#0B2545; --navy-2:#13315C; --teal:#0E7C86; --teal-soft:#E3F4F5;
--ink:#14213D; --muted:#5B6B82; --line:#DDE3EC; --bg:#F4F6FA;
--red:#B42318; --red-soft:#FDECEA; --amber:#B54708; --amber-soft:#FEF4E6;
--blue:#1D4ED8; --blue-soft:#E8EFFD;
}
html, body, [class*="css"], .stApp, .stMarkdown, button, input, label {font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif !important;}
.stApp{background:var(--bg);}
header[data-testid="stHeader"]{display:none;}
#MainMenu, footer, [data-testid="stSidebarCollapsedControl"]{display:none;}
.block-container{padding-top:0 !important; max-width:1180px;}

/* top bar */
.topbar{background:linear-gradient(90deg,var(--navy) 0%,var(--navy-2) 100%); color:#fff;
margin:0 -100vw 0 -100vw; padding:14px 100vw; display:flex; align-items:center; justify-content:space-between;}
.brand{display:flex; align-items:center; gap:12px;}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#2EC4B6,#0E7C86);
display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;color:#fff;}
.brand-name{font-weight:700;font-size:19px;letter-spacing:.2px;}
.brand-sub{font-size:12px;opacity:.75;margin-top:-2px;}
.topnav{display:flex;gap:22px;font-size:13.5px;opacity:.9;align-items:center;}
.chip{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);padding:5px 11px;border-radius:999px;font-size:12px;}
.subbar{background:#fff;border-bottom:1px solid var(--line);margin:0 -100vw 26px -100vw;padding:9px 100vw;
font-size:12.5px;color:var(--muted);display:flex;justify-content:space-between;}
.subbar b{color:var(--ink);}

/* stepper */
.stepper{display:flex;gap:0;margin:4px 0 22px 0;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.step{flex:1;padding:12px 14px;font-size:12.5px;color:var(--muted);border-right:1px solid var(--line);display:flex;gap:9px;align-items:center;}
.step:last-child{border-right:none;}
.step .n{width:24px;height:24px;border-radius:50%;border:1.5px solid #C5CEDB;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0;}
.step.done .n{background:var(--teal);border-color:var(--teal);color:#fff;}
.step.active{background:var(--teal-soft);color:var(--ink);font-weight:600;}
.step.active .n{background:var(--navy);border-color:var(--navy);color:#fff;}
.step.ext{background:repeating-linear-gradient(135deg,#fff,#fff 8px,#F7F8FB 8px,#F7F8FB 16px);}
.step.ext .n{border-style:dashed;}
.step small{display:block;font-weight:400;font-size:11px;color:var(--muted);}

/* headings */
.eyebrow{color:var(--teal);font-weight:700;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;}
.h1{font-size:30px;font-weight:800;color:var(--ink);margin:4px 0 6px 0;letter-spacing:-.4px;}
.lead{color:var(--muted);font-size:15px;max-width:760px;margin-bottom:20px;}

/* cards */
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:0 1px 2px rgba(16,24,40,.04);}
.scard{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 20px 14px 20px;min-height:250px;
box-shadow:0 1px 2px rgba(16,24,40,.04);border-top:5px solid var(--c);}
.scard .tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.8px;padding:4px 10px;border-radius:999px;background:var(--cs);color:var(--c);}
.scard h3{font-size:19px;margin:12px 0 6px 0;color:var(--ink);}
.scard p{color:var(--muted);font-size:13.5px;line-height:1.5;margin:0 0 10px 0;}
.scard .io{font-family:'JetBrains Mono',monospace;font-size:12px;background:#F7F8FB;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);line-height:1.6;}

/* form panels */
.panel-h{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.panel-h .ic{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;}
.panel-h .t{font-weight:700;font-size:16px;color:var(--ink);}
.panel-h .s{font-size:12px;color:var(--muted);}
.mock{display:inline-block;background:var(--amber-soft);color:var(--amber);font-weight:700;font-size:10.5px;padding:3px 8px;border-radius:6px;letter-spacing:.5px;margin-left:6px;}
[data-testid="stForm"]{background:#fff;border:1px solid var(--line) !important;border-radius:16px;padding:22px 24px 16px 24px;}
.stTextInput label p{font-weight:600 !important;color:var(--ink) !important;font-size:13px !important;}
.stTextInput [data-testid="stTextInputRootElement"]{background:#F7F8FB !important;border:1.5px solid #C9D2DF !important;border-radius:10px !important;}
.stTextInput [data-testid="stTextInputRootElement"]:focus-within{border-color:var(--teal) !important;box-shadow:0 0 0 3px rgba(14,124,134,.15);}
.stTextInput input::placeholder{color:#A3AEBF !important;font-style:italic;}
.stTextInput input{border-radius:10px !important;font-size:15px !important;color:var(--ink) !important;}
.fielderr{color:var(--red);font-size:12px;font-weight:600;margin:-6px 0 8px 2px;}

/* buttons */
.stButton button, .stFormSubmitButton button{border-radius:10px !important;font-weight:600 !important;padding:.5rem 1rem !important;}
.stFormSubmitButton button{background:var(--navy) !important;color:#fff !important;border:none !important;height:46px;font-size:15px !important;}
.stFormSubmitButton button:hover{background:var(--navy-2) !important;}
button[kind="primary"]{background:var(--navy) !important;border-color:var(--navy) !important;}

/* result banner */
.banner{border-radius:18px;padding:24px 26px;display:flex;gap:18px;align-items:flex-start;border:1px solid var(--bc);background:var(--bs);}
.banner .big{width:54px;height:54px;border-radius:14px;background:var(--bc);color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;flex-shrink:0;}
.banner .lbl{font-size:12px;font-weight:700;letter-spacing:1.2px;color:var(--bc);text-transform:uppercase;}
.banner .ttl{font-size:26px;font-weight:800;color:var(--ink);margin:2px 0 4px 0;letter-spacing:-.3px;}
.banner .code{font-family:'JetBrains Mono',monospace;font-size:14px;background:#fff;border:1px solid var(--bc);color:var(--bc);padding:3px 10px;border-radius:8px;display:inline-block;margin:4px 0 8px 0;font-weight:600;}
.banner .msg{color:var(--ink);font-size:14.5px;line-height:1.55;}
.banner .note{margin-top:10px;font-size:13px;color:var(--muted);font-style:italic;}

.sec{font-weight:700;font-size:15px;color:var(--ink);margin:4px 0 10px 0;}
.rec{width:100%;border-collapse:collapse;font-size:13.5px;}
.rec td{padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top;}
.rec td:first-child{color:var(--muted);width:42%;}
.raw{font-family:'JetBrains Mono',monospace;white-space:pre;background:#F7F8FB;border:1px solid var(--line);padding:2px 6px;border-radius:6px;font-size:12.5px;}
.blank{color:var(--red);font-style:italic;font-weight:600;}

.chk{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.chk th{background:#F7F8FB;text-align:left;font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--line);}
.chk td{padding:11px 14px;border-bottom:1px solid var(--line);}
.chk tr:last-child td{border-bottom:none;}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;font-size:11.5px;}
.pill.Pass{background:var(--teal-soft);color:var(--teal);}
.pill.Fail{background:var(--red-soft);color:var(--red);}
.pill.Not{background:#EEF1F5;color:var(--muted);}

.reason{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line);border-left:4px solid var(--rc);border-radius:10px;background:#fff;margin-bottom:8px;}
.reason .c{font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--rc);font-size:13px;white-space:nowrap;}
.reason .d{font-size:13.5px;color:var(--ink);}
.none{color:var(--muted);font-size:13.5px;padding:12px 14px;border:1px dashed var(--line);border-radius:10px;background:#fff;}

.pipe{display:flex;gap:8px;flex-wrap:wrap;}
.pn{flex:1;min-width:150px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:12.5px;}
.pn b{display:block;font-size:13px;color:var(--ink);margin-bottom:3px;}
.pn.cur{border:2px solid var(--teal);background:var(--teal-soft);}
.pn.ext{border-style:dashed;color:var(--muted);}
.foot{margin-top:34px;padding:16px 0 30px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;}
</style>
"""

SCENARIO_STYLE = {
    "PASS": {
        "c": "#0E7C86", "cs": "#E3F4F5", "icon": "✓", "tag": "SCENARIO 1 · PASS",
        "title": "Ready for verification",
        "label": "Consistency check passed",
    },
    "FAIL": {
        "c": "#B42318", "cs": "#FDECEA", "icon": "✕", "tag": "SCENARIO 2 · FAIL",
        "title": "Failed validation — missing or invalid data",
        "label": "Required data missing or invalid",
    },
    "UNDER_REVIEW": {
        "c": "#B54708", "cs": "#FEF4E6", "icon": "!", "tag": "SCENARIO 3 · UNDER REVIEW",
        "title": "Under review — data conflict",
        "label": "Records disagree",
    },
}


# --------------------------------------------------------------------------- layout pieces
def topbar() -> None:
    block(
        """
        <div class="topbar">
        <div class="brand"><div class="logo">M</div>
        <div><div class="brand-name">Meridian Bank</div><div class="brand-sub">Digital Account Opening · Compliance-first</div></div></div>
        <div class="topnav"><span>Onboarding Queue</span><span>Review Console</span><span>Policies</span>
        <span class="chip">👤 Reviewer: Demo Analyst</span></div>
        </div>
        <div class="subbar"><span><b>Onboarding checker</b> · Signup vs. mock ID consistency</span>
        <span>localhost:8501 · <b>Fictional data only</b> · No real KYC</span></div>
        """
    )


def stepper(active: int) -> None:
    steps = [
        ("Select scenario", "Pass · Fail · Review"),
        ("Enter records", "Signup + mock ID"),
        ("Consistency result", "This component"),
        ("Identity verification", "External · later"),
        ("Compliance & decision", "Human · later"),
    ]
    parts = []
    for i, (t, s) in enumerate(steps, start=1):
        cls = "ext" if i > 3 else ("done" if i < active else ("active" if i == active else ""))
        parts.append(f'<div class="step {cls}"><div class="n">{"✓" if cls == "done" else i}</div>'
                     f'<div>{t}<small>{s}</small></div></div>')
    block(f'<div class="stepper">{"".join(parts)}</div>')


def footer() -> None:
    block(
        """
        <div class="foot"><span>Meridian Bank Labs · USF AI in FinTech · Fictional classroom prototype</span>
        <span>Ready means consistent data, not approved identity. No account is created by this tool.</span></div>
        """
    )


# --------------------------------------------------------------------------- screens
def screen_home() -> None:
    stepper(1)
    block(
        """
        <div class="eyebrow">New account applications</div>
        <div class="h1">Onboarding consistency review</div>
        <div class="lead">Compare what the applicant typed at signup with the mock ID extraction before the
        record moves to external identity verification. Choose a scenario to walk through, or start a blank record.</div>
        """
    )
    examples = load_examples()
    cards = [
        ("PASS", "pass", "Matching records",
         "Signup and mock ID agree on name and birth date. The record is ready for the next verification step — not approved."),
        ("FAIL", "fail", "Missing ID date of birth",
         "The mock extraction returned no birth date. The checker refuses to compare and lists the missing field."),
        ("UNDER_REVIEW", "under_review", "Name conflict",
         "The ID reads “Dana Li” but signup says “Dana Lee.” No fuzzy matching — a reviewer must compare evidence."),
    ]
    cols = st.columns(3, gap="medium")
    for col, (cat, key, title, desc) in zip(cols, cards):
        sty, case = SCENARIO_STYLE[cat], examples[key]
        exp = case["expected"]
        with col:
            block(
                f"""
                <div class="scard" style="--c:{sty['c']};--cs:{sty['cs']}">
                <span class="tag">{sty['tag']}</span>
                <h3>{title}</h3><p>{desc}</p>
                <div class="io">signup: {esc(case['signup']['full_name'])} / {esc(case['signup']['date_of_birth']) or '(blank)'}<br>
                mock&nbsp;ID: {esc(case['extracted_id']['full_name'])} / {esc(case['extracted_id']['date_of_birth']) or '(blank)'}<br>
                → {exp['status']}{' / ' + ', '.join(exp['reasons']) if exp['reasons'] else ''}</div>
                </div>
                """
            )
            b1, b2 = st.columns(2)
            b1.button("Run scenario", key=f"run_{key}", type="primary", use_container_width=True,
                      on_click=run_scenario, args=(case, case["label"]))
            b2.button("Open in form", key=f"open_{key}", use_container_width=True,
                      on_click=go_to_form, args=(values_from_case(case), case["label"]))

    st.write("")
    left, right = st.columns([3, 1])
    with left:
        block(
            """
            <div class="card"><div class="sec">What this checker does — and does not do</div>
            <div style="font-size:13.5px;color:#5B6B82;line-height:1.6">
            ✔ Requires a nonblank name and a real <code>YYYY-MM-DD</code> birth date in <b>both</b> records ·
            ✔ Normalizes only case and spacing · ✔ Returns <code>READY_FOR_VERIFICATION</code> or <code>REVIEW</code> with reasons<br>
            ✘ Does not verify identity, run KYC/sanctions, judge document authenticity, or open an account.
            </div></div>
            """
        )
    with right:
        st.button("➕  Start blank application", use_container_width=True, type="primary",
                  on_click=go_to_form, args=({k: "" for k in FIELD_KEYS}, "Manual entry"))
        if st.session_state.result is not None:
            st.button("↩  View latest result", use_container_width=True,
                      on_click=lambda: st.session_state.update(screen="result"))


def screen_form() -> None:
    stepper(2)
    block(
        f"""
        <div class="eyebrow">Application record · {esc(st.session_state.scenario_label)}</div>
        <div class="h1">Enter signup and mock ID records</div>
        <div class="lead">Dates are plain text on purpose so a missing or invalid date can be demonstrated.
        Values are kept exactly as typed; the checker never rewrites them.</div>
        """
    )

    examples = load_examples()
    st.caption("Quick fill (fictional examples)")
    q = st.columns(5)
    q[0].button("Pass example", use_container_width=True, on_click=fill_example,
                args=(values_from_case(examples["pass"]), examples["pass"]["label"]))
    q[1].button("Fail example", use_container_width=True, on_click=fill_example,
                args=(values_from_case(examples["fail"]), examples["fail"]["label"]))
    q[2].button("Review example", use_container_width=True, on_click=fill_example,
                args=(values_from_case(examples["under_review"]), examples["under_review"]["label"]))
    # Small modification required by the guide (page 6).
    q[3].button('ID name → " DANA LEE "', use_container_width=True, on_click=set_id_name,
                args=(" DANA LEE ", "Modification: ' DANA LEE ' on the ID"),
                help="Fills only the mock ID name with leading/trailing spaces and capitals.")
    q[4].button("Clear all", use_container_width=True, on_click=fill_example,
                args=({k: "" for k in FIELD_KEYS}, "Manual entry"))

    # Inline validation messages from the latest result, shown next to the matching field.
    # Only show them while the fields still hold the values that produced that result.
    last = st.session_state.result or {"reasons": []}
    rec = st.session_state.record
    if rec is None or [st.session_state.get(k, "") for k in FIELD_KEYS] != [
        rec["signup"]["full_name"], rec["signup"]["date_of_birth"],
        rec["extracted_id"]["full_name"], rec["extracted_id"]["date_of_birth"],
    ]:
        last = {"reasons": []}
    errs = {
        "s_name": [r for r in last["reasons"] if r == "MISSING_SIGNUP_NAME"],
        "s_dob": [r for r in last["reasons"] if r in ("MISSING_SIGNUP_DOB", "INVALID_SIGNUP_DOB")],
        "i_name": [r for r in last["reasons"] if r == "MISSING_ID_NAME"],
        "i_dob": [r for r in last["reasons"] if r in ("MISSING_ID_DOB", "INVALID_ID_DOB")],
    }

    def field_err(key):
        for code in errs[key]:
            block(f'<div class="fielderr">⚠ {code}: {esc(REASON_TEXT[code])}</div>')

    with st.form("onboarding_form", border=False):
        left, right = st.columns(2, gap="large")
        with left:
            block(
                """<div class="panel-h"><div class="ic" style="background:#E3F4F5">📝</div>
                <div><div class="t">Signup record</div><div class="s">Entered by the applicant in the mobile app</div></div></div>"""
            )
            st.text_input("Full name", key="s_name", placeholder="Full legal name")
            field_err("s_name")
            st.text_input("Date of birth (YYYY-MM-DD)", key="s_dob", placeholder="YYYY-MM-DD")
            field_err("s_dob")
        with right:
            block(
                """<div class="panel-h"><div class="ic" style="background:#FEF4E6">🪪</div>
                <div><div class="t">ID document extraction <span class="mock">MOCK EXTRACTION</span></div>
                <div class="s">Fictional JSON standing in for a document extractor — not OCR, not verified</div></div></div>"""
            )
            st.text_input("Mock ID full name", key="i_name", placeholder="Full legal name")
            field_err("i_name")
            st.text_input("Mock ID date of birth (YYYY-MM-DD)", key="i_dob", placeholder="YYYY-MM-DD")
            field_err("i_dob")
        submitted = st.form_submit_button("Check onboarding record", use_container_width=True)

    if submitted:
        vals = {k: st.session_state.get(k, "") for k in FIELD_KEYS}
        st.session_state["field_values"] = vals
        submit_record(vals)
        st.rerun()

    st.button("← Back to scenarios", on_click=go_home)


def screen_result() -> None:
    result, record = st.session_state.result, st.session_state.record
    if result is None:
        go_home()
        st.rerun()
    signup, extracted = record["signup"], record["extracted_id"]
    cat = outcome_category(result)
    sty = SCENARIO_STYLE[cat]
    stepper(3)

    if cat == "PASS":
        msg = ("<b>Name:</b> match. <b>Birth date:</b> match. <b>Required fields:</b> complete.<br>"
               "<b>Next step:</b> send to external identity verification.")
        note = "Ready means consistent data, not approved identity. No customer account has been created."
    elif cat == "FAIL":
        missing = ", ".join(result["reasons"])
        msg = (f"<b>Reason{'s' if len(result['reasons']) > 1 else ''}:</b> {missing}.<br>"
               "Validation failed, so the names and dates were <b>not compared</b>. "
               "Request the missing or corrected information from the applicant or source document.")
        note = "Do not invent, guess or auto-correct a value. The record stays in REVIEW until both records are complete and valid."
    else:
        msg = (f"<b>Reason{'s' if len(result['reasons']) > 1 else ''}:</b> {', '.join(result['reasons'])}.<br>"
               "Compare signup and source evidence before continuing.")
        note = "Do not silently correct the document name or date. Spelling differences stay mismatches."

    block(
        f"""
        <div class="banner" style="--bc:{sty['c']};--bs:{sty['cs']}">
        <div class="big">{sty['icon']}</div>
        <div><div class="lbl">{sty['tag']} · {sty['label']}</div>
        <div class="ttl">{sty['title']}</div>
        <span class="code">status: {result['status']}</span>
        <div class="msg">{msg}</div>
        <div class="note">{note}</div></div>
        </div>
        """
    )
    st.write("")

    # Original records, side by side, exactly as entered.
    c1, c2 = st.columns(2, gap="medium")
    with c1:
        block(
            f"""<div class="card"><div class="sec">📝 Signup record (original)</div>
            <table class="rec"><tr><td>full_name</td><td>{shown_raw(signup['full_name'])}</td></tr>
            <tr><td>date_of_birth</td><td>{shown_raw(signup['date_of_birth'])}</td></tr></table></div>"""
        )
    with c2:
        block(
            f"""<div class="card"><div class="sec">🪪 Mock ID extraction (original) <span class="mock">MOCK</span></div>
            <table class="rec"><tr><td>full_name</td><td>{shown_raw(extracted['full_name'])}</td></tr>
            <tr><td>date_of_birth</td><td>{shown_raw(extracted['date_of_birth'])}</td></tr></table></div>"""
        )
    st.write("")

    left, right = st.columns([3, 2], gap="medium")
    with left:
        block('<div class="sec">Comparison checklist</div>')
        rows = []
        for check, sv, iv, outcome in comparison_checklist(signup, extracted, result):
            pill = "Not" if outcome == "Not compared" else outcome
            rows.append(
                f"<tr><td>{esc(check)}</td><td>{shown_raw(sv) if sv else '—'}</td>"
                f"<td>{shown_raw(iv) if iv else '—'}</td><td><span class='pill {pill}'>{outcome}</span></td></tr>"
            )
        block(
            f"""<table class="chk"><tr><th>Check</th><th>Signup</th><th>Mock ID</th><th>Result</th></tr>
            {''.join(rows)}</table>"""
        )
    with right:
        block('<div class="sec">Reason codes</div>')
        if result["reasons"]:
            for code in result["reasons"]:
                block(
                    f"""<div class="reason" style="--rc:{sty['c']}"><div class="c">{code}</div>
                    <div class="d">{esc(REASON_TEXT.get(code, ''))}</div></div>"""
                )
        else:
            block('<div class="none">reasons = [] · No missing fields and no conflicts.</div>')

    st.write("")
    block('<div class="sec">Where this record goes next</div>')
    nxt = "Queued for external check" if result["status"] == READY else "Blocked until reviewer resolves"
    block(
        f"""<div class="pipe">
        <div class="pn"><b>1 · Signup & ID evidence</b>Fictional inputs captured</div>
        <div class="pn"><b>2 · Mock AI extraction</b>Not authoritative</div>
        <div class="pn cur"><b>3 · Completeness & consistency</b>{result['status']}</div>
        <div class="pn ext"><b>4 · Identity provider</b>{nxt}</div>
        <div class="pn ext"><b>5 · Compliance & account decision</b>Human decision · out of scope</div>
        </div>"""
    )
    st.write("")
    with st.expander("Raw checker output (logic.check_onboarding)"):
        st.code(json.dumps(result, indent=2), language="json")
        st.code(json.dumps(record, indent=2), language="json")

    b1, b2, _ = st.columns([1, 1, 3])
    b1.button("✎ Edit this record", type="primary", use_container_width=True, on_click=go_to_form)
    b2.button("← All scenarios", use_container_width=True, on_click=go_home)


# --------------------------------------------------------------------------- main
init_state()
block(CSS)
topbar()
{"home": screen_home, "form": screen_form, "result": screen_result}[st.session_state.screen]()
footer()
