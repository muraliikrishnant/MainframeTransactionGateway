import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function writeAudit({ actor, action, target, detail, ip }) {
  await pool.query(
    `INSERT INTO audit_log (actor, action, target, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, target ?? null, detail ? JSON.stringify(detail) : null, ip ?? null]
  );
}
