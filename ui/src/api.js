const BASE = "/api";

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(username, password) {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error || "login failed");
  return res.json();
}

export async function getAccounts(token) {
  const res = await fetch(`${BASE}/accounts`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error((await res.json()).error || "failed to load accounts");
  return res.json();
}

export async function getTransactions(token) {
  const res = await fetch(`${BASE}/transactions`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error((await res.json()).error || "failed to load transactions");
  return res.json();
}

export async function postTransaction(token, payload) {
  const res = await fetch(`${BASE}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.reason || "transaction failed");
  return data;
}

export async function getAudit(token) {
  const res = await fetch(`${BASE}/audit`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error((await res.json()).error || "failed to load audit log");
  return res.json();
}

export async function getFraudAlerts(token) {
  const res = await fetch(`${BASE}/fraud-alerts`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error((await res.json()).error || "failed to load fraud alerts");
  return res.json();
}

export async function getBatchRuns(token) {
  const res = await fetch(`${BASE}/batch-runs`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error((await res.json()).error || "failed to load batch runs");
  return res.json();
}
