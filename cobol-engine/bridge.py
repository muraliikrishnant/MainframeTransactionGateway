"""
bridge.py
Simulates an IMS Connect / z/OS Connect bridge: exposes the compiled
COBOL transaction program (txnengine) over HTTP so the modern gateway
can call it like any other microservice.
"""
import os
import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)
ENGINE_BIN = os.path.join(os.path.dirname(__file__), "txnengine")
INTEREST_BIN = os.path.join(os.path.dirname(__file__), "interest")
INSTANCE_ID = os.environ.get("ENGINE_INSTANCE_ID", "unknown")


@app.get("/health")
def health():
    return jsonify(status="UP", engine="TXNENGINE", mode="GnuCOBOL", instance=INSTANCE_ID)


@app.post("/txn")
def run_transaction():
    body = request.get_json(force=True)
    txn_type = body.get("txnType")
    from_balance = int(body.get("fromBalance", 0))
    to_balance = int(body.get("toBalance", 0))
    amount = int(body.get("amount", 0))

    if txn_type not in ("DEPOSIT", "WITHDRAW", "TRANSFER"):
        return jsonify(error="invalid txnType"), 400

    input_line = f"{txn_type}|{from_balance}|{to_balance}|{amount}\n"

    proc = subprocess.run(
        [ENGINE_BIN],
        input=input_line,
        capture_output=True,
        text=True,
        timeout=5,
    )

    if proc.returncode != 0:
        return jsonify(error="cobol engine failure", stderr=proc.stderr), 500

    out = proc.stdout.strip()
    parts = out.split("|")
    if len(parts) != 4:
        return jsonify(error="unexpected engine output", raw=out), 500

    result, new_from, new_to, reason = parts
    return jsonify(
        result=result.strip(),
        newFromBalance=int(new_from.strip()),
        newToBalance=int(new_to.strip()),
        reason=reason.strip(),
        trace=f"TXNENGINE:{txn_type}:{result.strip()}:{INSTANCE_ID}",
    )


@app.post("/interest")
def run_interest():
    """
    Invoked once per account by the batch scheduler. Delegates the actual
    accrual math to the compiled INTEREST.cob program so the business rule
    lives in COBOL, same split as the /txn path.
    """
    body = request.get_json(force=True)
    balance = int(body.get("balanceCents", 0))
    rate_bp = int(body.get("rateBasisPoints", 3))  # default ~3bp/day demo rate

    input_line = f"{balance}|{rate_bp}\n"
    proc = subprocess.run(
        [INTEREST_BIN], input=input_line, capture_output=True, text=True, timeout=5
    )
    if proc.returncode != 0:
        return jsonify(error="cobol engine failure", stderr=proc.stderr), 500

    out = proc.stdout.strip()
    parts = out.split("|")
    if len(parts) != 2:
        return jsonify(error="unexpected engine output", raw=out), 500

    interest_amount, new_balance = parts
    return jsonify(
        interestAmountCents=int(interest_amount.strip()),
        newBalanceCents=int(new_balance.strip()),
        trace=f"INTEREST:{INSTANCE_ID}",
    )


if __name__ == "__main__":
    port = int(os.environ.get("ENGINE_PORT", 9001))
    app.run(host="0.0.0.0", port=port)
