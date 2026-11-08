import { jest } from "@jest/globals";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test_secret";

const { signToken, requireAuth, requireRole } = await import("./auth.js");

function mockRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

describe("signToken", () => {
  it("embeds username and role as claims", () => {
    const token = signToken({ user_id: 1, username: "teller1", role: "TELLER" });
    const decoded = jwt.verify(token, "test_secret");
    expect(decoded.username).toBe("teller1");
    expect(decoded.role).toBe("TELLER");
  });
});

describe("requireAuth", () => {
  it("rejects requests with no Authorization header", () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid/expired token", () => {
    const req = { headers: { authorization: "Bearer not-a-real-token" } };
    const res = mockRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a valid token and attaches claims to req.user", () => {
    const token = signToken({ user_id: 1, username: "auditor1", role: "AUDITOR" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.username).toBe("auditor1");
    expect(req.user.role).toBe("AUDITOR");
  });
});

describe("requireRole", () => {
  it("blocks a role that is not in the allowed list (e.g. AUDITOR posting a transaction)", () => {
    const req = { user: { role: "AUDITOR" } };
    const res = mockRes();
    const next = jest.fn();
    requireRole("TELLER")(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a role that is in the allowed list", () => {
    const req = { user: { role: "TELLER" } };
    const res = mockRes();
    const next = jest.fn();
    requireRole("TELLER", "AUDITOR")(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks when req.user is missing entirely", () => {
    const req = {};
    const res = mockRes();
    const next = jest.fn();
    requireRole("TELLER")(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
