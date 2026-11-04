"""Claim completeness -- Streamlit screen.

One screen: a form in, a result out. Calls logic.check_claim rather than
re-implementing its rules (build guide page 6, step 3: "keep display and
logic separate"). Mock document names stand in for evidence; no real file
upload or OCR here. This screen decides readiness for an adjuster to begin
review -- never coverage, denial, or payment.
"""

import streamlit as st

from logic import check_claim, next_steps_for

st.set_page_config(page_title="Claim completeness", page_icon=":mag:")

st.title("Claim completeness")
st.caption("localhost:8501 | Fictional data")

if "result" not in st.session_state:
    st.session_state.result = None
    st.session_state.submitted_claim = None

inputs_col, result_col = st.columns(2)

with inputs_col:
    st.subheader("Inputs")
    with st.form("claim_form"):
        policy_id = st.text_input("Policy ID", placeholder="P001")
        incident_date = st.text_input("Incident date", placeholder="2026-09-20")
        description = st.text_area(
            "Description", placeholder="Minor water damage in kitchen"
        )
        documents_text = st.text_area(
            "Mock document names (one per line)",
            placeholder="photo_01.jpg",
            help="Fictional evidence labels only -- no real file upload.",
        )
        submitted = st.form_submit_button("Check claim completeness")

    if submitted:
        documents = [line for line in documents_text.splitlines()]
        claim = {
            "policy_id": policy_id,
            "incident_date": incident_date,
            "description": description,
            "documents": documents,
        }
        st.session_state.submitted_claim = claim
        st.session_state.result = check_claim(claim)

with result_col:
    st.subheader("Result")
    claim = st.session_state.submitted_claim
    result = st.session_state.result

    if result is None:
        st.write("Submit a claim to see its completeness result here.")
    else:
        status = result["status"]
        missing = result["missing"]

        if status == "READY_FOR_REVIEW":
            st.success("READY_FOR_REVIEW")
            st.write("Required fields complete. Missing items: none.")
            st.write("Send this case to an adjuster for review.")
        else:
            st.error("NEEDS_INFORMATION")
            st.write(f"Missing: {', '.join(missing)}.")
            for message in next_steps_for(missing):
                st.write(f"- {message}")

        st.caption("Readiness does not determine coverage or payment.")

        st.markdown("**Checklist**")
        fields = [
            ("policy_id", "Policy ID", claim.get("policy_id", "")),
            ("incident_date", "Incident date", claim.get("incident_date", "")),
            ("description", "Description", claim.get("description", "")),
        ]
        for key, label, value in fields:
            present = key not in missing
            mark = ":white_check_mark:" if present else ":x:"
            shown = value.strip() if isinstance(value, str) and value.strip() else "Blank"
            st.write(f"{mark} **{label}:** {shown}")

        docs = claim.get("documents", [])
        nonblank_docs = [d for d in docs if isinstance(d, str) and d.strip()]
        docs_present = "documents" not in missing
        mark = ":white_check_mark:" if docs_present else ":x:"
        shown_docs = ", ".join(nonblank_docs) if nonblank_docs else "None"
        st.write(f"{mark} **Mock document names:** {shown_docs}")

st.divider()
st.caption(
    "This checks whether a case has enough information for a human adjuster "
    "to begin review. It does not approve, deny, calculate, or pay a claim."
)
