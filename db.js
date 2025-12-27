// evania-backend/db.js
import Database from "better-sqlite3";

export const db = new Database("./evania.db");
db.pragma("journal_mode = WAL");

/**
 * Full schema for:
 * - users         (Member A + XP fields + prefs)
 * - quests        (Member B)
 * - runs          (Member B)
 * - routines      (Member C)
 * - routine_logs  (Member C)
 *
 * If you already had an older evania.db with fewer columns,
 * delete that file once so this schema can be applied cleanly.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  total_xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  last_active_local_date TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  avatar_tier INTEGER NOT NULL DEFAULT 0,
  theme_color TEXT DEFAULT '#6C7EFF',
  daily_target INTEGER DEFAULT 1,
  goals_json TEXT DEFAULT '[]',
  baseline_mood TEXT DEFAULT 'neutral',
  onboarding_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  base_points INTEGER NOT NULL,
  category TEXT,
  cooldown_sec INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  gained_xp INTEGER NOT NULL,
  streak_applied INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(quest_id) REFERENCES quests(id)
);

CREATE INDEX IF NOT EXISTS runs_user_date_idx
  ON runs(user_id, local_date);

-- Member C: routines
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  base_points INTEGER NOT NULL DEFAULT 6,
  daily_target INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Member C: routine logs
CREATE TABLE IF NOT EXISTS routine_logs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  gained_xp INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  FOREIGN KEY(routine_id) REFERENCES routines(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS routine_logs_user_date_idx
  ON routine_logs(user_id, local_date);
`);

/**
 * Seed default quests if empty
 */
const countQuests = db.prepare("SELECT COUNT(*) AS c FROM quests").get().c;
if (countQuests === 0) {
  const seed = db.prepare(`
    INSERT INTO quests (id, title, base_points, category, cooldown_sec, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  const rows = [
    ["q1", "2-min Breathing", 10, "mindfulness", 0],
    ["q2", "Drink Water", 5, "self-care", 3600],
    ["q3", "10 Push-ups", 12, "fitness", 0],
    ["q4", "Journal 3 lines", 15, "reflection", 0],
  ];

  const trx = db.transaction(() => {
    rows.forEach((r) => seed.run(...r));
  });
  trx();
}
