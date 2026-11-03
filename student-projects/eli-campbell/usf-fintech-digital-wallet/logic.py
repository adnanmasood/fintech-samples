"""Business logic for the fictional Digital Wallet Transfer System (no UI imports)."""
import copy

WALLETS = ("A", "B")
INITIAL_BALANCES = {"A": 10000, "B": 2000}


def new_state():
    return {"balances": dict(INITIAL_BALANCES), "requests": {}}


def moved_balances(balances, sender, recipient, amount_cents):
    updated = balances.copy()
    updated[sender] -= amount_cents
    updated[recipient] += amount_cents
    return updated


def total_funds(state):
    """Sum of all wallet balances in cents (should never change)."""
    return sum(state["balances"].values())


def _result(status, request_id, reason, **extra):
    result = {"status": status, "request_id": request_id, "reason": reason}
    result.update(extra)
    return result


def transfer(state, request):
    """Return (new_state, result). The input state is never mutated."""
    raw_id = request.get("request_id")
    request_id = raw_id.strip() if isinstance(raw_id, str) else ""
    sender = request.get("sender")
    recipient = request.get("recipient")
    amount = request.get("amount_cents")
    currency = request.get("currency")

    # Rule 1
    if not request_id:
        return state, _result("INVALID_REQUEST", request_id, "Request ID is blank.")
    if sender not in WALLETS or recipient not in WALLETS:
        return state, _result("INVALID_REQUEST", request_id, "Unknown wallet.")
    if sender == recipient:
        return state, _result("INVALID_REQUEST", request_id, "Sender and recipient must differ.")
    if currency != "USD":
        return state, _result("INVALID_REQUEST", request_id, "Currency must be USD.")

    # Rule 2 (bool is a subclass of int, so reject it explicitly)
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        return state, _result("INVALID_AMOUNT", request_id, "Amount must be a positive integer of cents.")

    payload = {"sender": sender, "recipient": recipient,
               "amount_cents": amount, "currency": currency}

    # Rules 3 and 4
    recorded = state["requests"].get(request_id)
    if recorded is not None:
        if recorded["payload"] == payload:
            return state, _result("DUPLICATE_REQUEST", request_id,
                                  "Request already completed.",
                                  original_receipt=copy.deepcopy(recorded["receipt"]))
        return state, _result("REQUEST_CONFLICT", request_id,
                              "Request ID was used with different details.")

    # Rule 5
    if state["balances"][sender] < amount:
        return state, _result("INSUFFICIENT_FUNDS", request_id, "Sender balance is too low.")

    # Rule 6
    balances = moved_balances(state["balances"], sender, recipient, amount)
    receipt = {"request_id": request_id, **payload, "balances_after": balances.copy()}
    requests = copy.deepcopy(state["requests"])
    requests[request_id] = {"payload": payload, "receipt": receipt}
    new = {"balances": balances, "requests": requests}
    return new, _result("COMPLETED", request_id, "Transfer completed.", receipt=copy.deepcopy(receipt))
