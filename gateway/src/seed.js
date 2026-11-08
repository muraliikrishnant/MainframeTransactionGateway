import bcrypt from "bcryptjs";
import { pool } from "./db.js";

async function seed() {
  const users = [
    { username: "teller1", password: "teller123", role: "TELLER" },
    { username: "auditor1", password: "auditor123", role: "AUDITOR" },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 12);
    await pool.query(
      `INSERT INTO app_users (username, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hash, u.role]
    );
    console.log(`seeded user: ${u.username} / ${u.role}`);
  }

  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
