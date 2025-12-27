// evania-backend/migrate.js
const Database = require("better-sqlite3");

const db = new Database("./evania.db");
db.pragma("journal_mode = WAL");

function hasColumn(table, name) {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all();
  return rows.some((r) => r.name === name);
}
function addColumn(table, name, sql) {
  if (!hasColumn(table, name)) {
    console.log(`Adding column ${name} to ${table}...`);
    db.exec(sql);
  } else {
    console.log(`Column ${name} already exists, skipping.`);
  }
}

db.exec("BEGIN");
try {
  addColumn("users", "email",               `ALTER TABLE users ADD COLUMN email TEXT;`);
  addColumn("users", "password_hash",       `ALTER TABLE users ADD COLUMN password_hash TEXT;`);
  addColumn("users", "theme_color",         `ALTER TABLE users ADD COLUMN theme_color TEXT DEFAULT '#6C7EFF';`);
  addColumn("users", "daily_target",        `ALTER TABLE users ADD COLUMN daily_target INTEGER DEFAULT 1;`);
  addColumn("users", "goals_json",          `ALTER TABLE users ADD COLUMN goals_json TEXT DEFAULT '[]';`);
  addColumn("users", "baseline_mood",       `ALTER TABLE users ADD COLUMN baseline_mood TEXT DEFAULT 'neutral';`);
  addColumn("users", "onboarding_done",     `ALTER TABLE users ADD COLUMN onboarding_done INTEGER DEFAULT 0;`);
  db.exec("COMMIT");
  console.log("Migration complete ✅");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("Migration failed:", e.message);
  process.exit(1);
} finally {
  db.close();
}
