"""Business rules for the Supplier Invoice Approval System.

No Streamlit imports here. app.py collects form values and calls
check_invoice(); this module owns validation, the duplicate key, and the
in-memory record state. All data is fictional classroom data — there is no
model API call and no database in this module.
"""

# Result statuses. No APPROVED, PAID, or payment-sent status exists here:
# this component only validates intake and flags duplicates.
STATUS_INVALID = "INVALID_INPUT"
STATUS_DUPLICATE = "DUPLICATE"
STATUS_PENDING = "PENDING_APPROVAL"


def invoice_key(invoice):
    """Build the duplicate-detection key from supplier_id + invoice_number.

    Caller validates required strings before using this helper. Two
    suppliers can both use the same invoice number, so the key must be a
    pair, not the invoice number alone. The key deliberately excludes
    "filename" and "amount_cents" so a changed filename or amount cannot
    create a second record for the same obligation.
    """
    return (invoice["supplier_id"].strip(), invoice["invoice_number"].strip())


def _is_blank(value):
    """True when value is missing, not a string, or empty after trimming."""
    return not isinstance(value, str) or value.strip() == ""


def _is_valid_amount(value):
    """Positive integer cents only. bool is rejected even though it is an
    int subclass in Python, and fractional amounts are rejected."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def check_invoice(records, invoice):
    """Validate and deduplicate one fictional invoice submission.

    Args:
        records: existing dict of {(supplier_id, invoice_number): invoice}.
            Never mutated in place.
        invoice: dict with supplier_id, invoice_number, amount_cents, and
            an optional filename.

    Returns:
        (new_records, result) where:
          - new_records is `records` unchanged for INVALID_INPUT and
            DUPLICATE, or a new dict (shallow copy plus one entry) for a
            valid new pair.
          - result contains "status", "reason", and "key" (key is None
            when the input could not be validated). A DUPLICATE result
            also contains "existing_invoice"; a PENDING_APPROVAL result
            also contains "invoice" (the newly stored record).

    Rules are applied in this order:
        1. Missing/blank supplier_id or invoice_number -> INVALID_INPUT.
        2. Non-integer or non-positive amount_cents (bool rejected) ->
           INVALID_INPUT.
        3. Key = (trimmed supplier_id, trimmed invoice_number); case is
           preserved.
        4. Key already in records -> DUPLICATE, original record returned
           unchanged, even if amount or filename differs this time.
        5. Same invoice_number with a different supplier_id is a
           different key and is not a duplicate.
        6. New key -> PENDING_APPROVAL; store exactly one invoice.
    """
    supplier_id = invoice.get("supplier_id")
    invoice_number = invoice.get("invoice_number")
    amount_cents = invoice.get("amount_cents")
    filename = invoice.get("filename")

    if _is_blank(supplier_id) or _is_blank(invoice_number):
        return records, {
            "status": STATUS_INVALID,
            "reason": "supplier_id and invoice_number are required and cannot be blank",
            "key": None,
        }

    if not _is_valid_amount(amount_cents):
        return records, {
            "status": STATUS_INVALID,
            "reason": "amount_cents must be a positive integer (not a boolean or fraction)",
            "key": None,
        }

    key = invoice_key({"supplier_id": supplier_id, "invoice_number": invoice_number})

    if key in records:
        existing = records[key]
        return records, {
            "status": STATUS_DUPLICATE,
            "reason": (
                "An invoice already exists for this supplier/invoice pair; "
                "the original record is unchanged"
            ),
            "key": key,
            "existing_invoice": existing,
        }

    new_record = {
        "supplier_id": key[0],
        "invoice_number": key[1],
        "amount_cents": amount_cents,
        "filename": filename,
        "status": STATUS_PENDING,
    }
    new_records = dict(records)
    new_records[key] = new_record

    return new_records, {
        "status": STATUS_PENDING,
        "reason": "New invoice recorded and pending approval",
        "key": key,
        "invoice": new_record,
    }


def duplicate_explanation(existing_invoice, submitted_invoice):
    """Describe the amount gap behind a DUPLICATE result.

    Read-only: does not touch `records` or change the stored invoice.
    Takes the existing stored record (e.g. result["existing_invoice"]
    from check_invoice) and the invoice as resubmitted, and returns the
    original amount, the newly submitted amount, and their difference in
    cents (submitted minus original; can be negative).
    """
    original_amount_cents = existing_invoice["amount_cents"]
    submitted_amount_cents = submitted_invoice["amount_cents"]
    return {
        "original_amount_cents": original_amount_cents,
        "submitted_amount_cents": submitted_amount_cents,
        "difference_cents": submitted_amount_cents - original_amount_cents,
    }
