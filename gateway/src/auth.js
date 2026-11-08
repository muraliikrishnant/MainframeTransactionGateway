import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

export function signToken(user) {
  return jwt.sign(
    { sub: user.user_id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "30m" }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing bearer token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

// RBAC guard: mirrors Db2 GRANT ... TO ROLE — each route declares which
// roles may call it, enforced centrally rather than scattered in handlers.
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "insufficient role" });
    }
    next();
  };
}
