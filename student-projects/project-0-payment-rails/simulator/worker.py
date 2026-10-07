"""One queue consumer and one participant instance per operating-system process."""
import os
import signal
import traceback
from .payer import Payer
from .merchant import Merchant
from .gateway import Gateway
from .acquirer import Acquirer
from .network import Network
from .issuer import Issuer


def worker_loop(role, inbox, results, session_id, accounts):
    # Ctrl+C belongs to the supervisor; workers stop through their queue sentinel.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    factories = {"payer": Payer, "merchant": Merchant, "gateway": Gateway,
                 "acquirer": Acquirer, "network": Network, "issuer": lambda: Issuer(accounts)}
    participant = factories[role]()
    received = sent = 0
    results.put({"role": role, "session_id": session_id, "ready": True,
                 "pid": os.getpid(), "snapshot": participant.snapshot()})
    while True:
        packet = inbox.get()
        if packet is None:
            break
        delivery_id, message = packet
        try:
            result = participant.handle(message)
            received += 1
            sent += len(result["outgoing"])
            results.put({"role": role, "session_id": session_id, "delivery_id": delivery_id,
                         "pid": os.getpid(), "received": received, "sent": sent,
                         "result": result, "snapshot": participant.snapshot()})
        except Exception:
            # Unexpected programming failures never fabricate a bank response.
            results.put({"role": role, "session_id": session_id, "delivery_id": delivery_id,
                         "fatal": traceback.format_exc()})
            break
