#!/bin/bash
# Regression suite for the COBOL transaction engine, run against a live
# cobol-engine container (CI builds and starts it before running this).
# Each case fires a real HTTP request into the real compiled COBOL binary
# and asserts on its decision — this is testing the business rule itself,
# not a mock of it.
set -uo pipefail

ENGINE_URL="${ENGINE_URL:-http://localhost:9001}"
FAILURES=0

assert_field() {
  local description="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$field'))")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $description -- expected $field=$expected, got $field=$actual (full: $json)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $description"
  fi
}

call_txn() {
  curl -s -X POST "$ENGINE_URL/txn" -H 'Content-Type: application/json' -d "$1"
}

# --- DEPOSIT always succeeds for a positive amount ---
RESP=$(call_txn '{"txnType":"DEPOSIT","fromBalance":0,"toBalance":1000,"amount":500}')
assert_field "deposit posts" "$RESP" "result" "POSTED"
assert_field "deposit credits destination" "$RESP" "newToBalance" "1500"

# --- WITHDRAW succeeds when funds are sufficient ---
RESP=$(call_txn '{"txnType":"WITHDRAW","fromBalance":1000,"toBalance":0,"amount":400}')
assert_field "withdraw within balance posts" "$RESP" "result" "POSTED"
assert_field "withdraw debits source" "$RESP" "newFromBalance" "600"

# --- WITHDRAW rejected when funds are insufficient ---
RESP=$(call_txn '{"txnType":"WITHDRAW","fromBalance":100,"toBalance":0,"amount":500}')
assert_field "withdraw beyond balance rejects" "$RESP" "result" "REJECTED"
assert_field "rejects with insufficient funds reason" "$RESP" "reason" "INSUFFICIENT FUNDS"

# --- TRANSFER moves funds between two balances ---
RESP=$(call_txn '{"txnType":"TRANSFER","fromBalance":1000,"toBalance":200,"amount":300}')
assert_field "transfer posts" "$RESP" "result" "POSTED"
assert_field "transfer debits source" "$RESP" "newFromBalance" "700"
assert_field "transfer credits destination" "$RESP" "newToBalance" "500"

# --- TRANSFER rejected when source funds are insufficient ---
RESP=$(call_txn '{"txnType":"TRANSFER","fromBalance":50,"toBalance":0,"amount":500}')
assert_field "transfer beyond balance rejects" "$RESP" "result" "REJECTED"

# --- Zero/negative amounts are always rejected ---
RESP=$(call_txn '{"txnType":"DEPOSIT","fromBalance":0,"toBalance":0,"amount":0}')
assert_field "zero amount rejects" "$RESP" "result" "REJECTED"

# --- Interest engine: known rate produces known accrual ---
RESP=$(curl -s -X POST "$ENGINE_URL/interest" -H 'Content-Type: application/json' -d '{"balanceCents":1000000,"rateBasisPoints":100}')
assert_field "interest accrues expected amount" "$RESP" "interestAmountCents" "100"
assert_field "interest produces expected new balance" "$RESP" "newBalanceCents" "1000100"

echo "---"
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES assertion(s) FAILED"
  exit 1
fi
echo "all assertions passed"
