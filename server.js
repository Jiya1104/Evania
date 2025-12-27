import express from "express";
import cors from "cors";
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js"; // Member D
import { nanoid } from "nanoid";
import { db } from "./db.js";

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

dayjs.extend(isoWeek); // Member D

const DEFAULT_TZ = "Asia/Kolkata";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------------------------------------
 * Prepared statements
 * ------------------------------------------------*/
const sql = {
  // Member A/B user
  getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
  // IMPORTANT FIX: do not reference @created_at; set created_at = datetime('now') directly
  upsertUser: db.prepare(`
    INSERT INTO users(
      id, email, password_hash,
      total_xp, level, current_streak, longest_streak,
      last_active_local_date, timezone, avatar_tier,
      theme_color, daily_target, goals_json, baseline_mood,
      onboarding_done, created_at
    )
    VALUES(
      @id, @email, @password_hash,
      @total_xp, @level, @current_streak, @longest_streak,
      @last_active_local_date, @timezone, @avatar_tier,
      @theme_color, @daily_target, @goals_json, @baseline_mood,
      @onboarding_done, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      email=COALESCE(excluded.email, users.email),
      password_hash=COALESCE(excluded.password_hash, users.password_hash),
      total_xp=excluded.total_xp,
      level=excluded.level,
      current_streak=excluded.current_streak,
      longest_streak=excluded.longest_streak,
      last_active_local_date=excluded.last_active_local_date,
      timezone=excluded.timezone,
      avatar_tier=excluded.avatar_tier,
      theme_color=COALESCE(excluded.theme_color, users.theme_color),
      daily_target=COALESCE(excluded.daily_target, users.daily_target),
      goals_json=COALESCE(excluded.goals_json, users.goals_json),
      baseline_mood=COALESCE(excluded.baseline_mood, users.baseline_mood),
      onboarding_done=COALESCE(excluded.onboarding_done, users.onboarding_done)
  `),

  // Member B quests/runs
  listQuests: db.prepare("SELECT * FROM quests WHERE active = 1"),
  getQuest: db.prepare("SELECT * FROM quests WHERE id = ? AND active = 1"),
  lastRunForQuest: db.prepare(`
    SELECT * FROM runs
    WHERE user_id = ? AND quest_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `),
  insertRun: db.prepare(`
    INSERT INTO runs(
      id, user_id, quest_id, gained_xp,
      streak_applied, created_at, local_date
    )
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `),
  listRunsByUser: db.prepare(`
    SELECT * FROM runs
    WHERE user_id = ?
    ORDER BY created_at DESC
  `),

  // Member C routines
  insertRoutine: db.prepare(`
    INSERT INTO routines(id, user_id, title, base_points, daily_target, active)
    VALUES(?, ?, ?, ?, ?, 1)
  `),
  getRoutineById: db.prepare(`
    SELECT * FROM routines
    WHERE id = ? AND user_id = ? AND active = 1
  `),
  countRoutineLogsToday: db.prepare(`
    SELECT COUNT(*) AS c
    FROM routine_logs
    WHERE routine_id = ?
      AND user_id = ?
      AND local_date = ?
  `),
  insertRoutineLog: db.prepare(`
    INSERT INTO routine_logs(
      id, routine_id, user_id, gained_xp, created_at, local_date
    )
    VALUES(?, ?, ?, ?, ?, ?)
  `),
};

/* ------------------------------------------------
 * Helpers
 * ------------------------------------------------*/
const computeLevel = (totalXP) =>
  Math.floor(Math.sqrt(totalXP) / 2) + 1;

function localDateISO() {
  return dayjs().format("YYYY-MM-DD");
}

function applyStreakProgress(u) {
  const today = localDateISO();
  if (!u.last_active_local_date) {
    u.current_streak = 1;
  } else {
    const diff = dayjs(today).diff(dayjs(u.last_active_local_date), "day");
    if (diff === 0) {
      // same day → keep streak
    } else if (diff === 1) {
      u.current_streak = (u.current_streak || 0) + 1;
    } else {
      u.current_streak = 1;
    }
  }
  u.longest_streak = Math.max(u.longest_streak || 0, u.current_streak || 0);
  u.last_active_local_date = today;
}

function streakMultiplier(streak) {
  if (!streak || streak < 1) return 1.0;
  const perDay = Math.min(0.05 * streak, 0.5); // up to +50%
  const band = Math.floor(streak / 7) * 0.1;  // +10% per full week
  return parseFloat((1.0 + perDay + band).toFixed(2));
}

/* ------------------------------------------------
 * Auth / identity middleware
 * ------------------------------------------------*/
app.use((req, _res, next) => {
  const auth = req.headers.authorization; // Bearer <token>
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      req.authUserId = payload.sub || payload.userId;
    } catch {
      // ignore invalid, fallback below
    }
  }
  if (!req.authUserId) {
    // Dev fallback: allow x-user-id or demo-user
    req.authUserId = req.header("x-user-id") || "demo-user";
  }
  next();
});

/* ------------------------------------------------
 * Ensure user row exists
 * ------------------------------------------------*/
app.use((req, _res, next) => {
  const userId = req.authUserId;
  let u = sql.getUser.get(userId);
  if (!u) {
    u = {
      id: userId,
      email: null,
      password_hash: null,
      total_xp: 0,
      level: 1,
      current_streak: 0,
      longest_streak: 0,
      last_active_local_date: null,
      timezone: DEFAULT_TZ,
      avatar_tier: 0,
      theme_color: "#6C7EFF",
      daily_target: 1,
      goals_json: "[]",
      baseline_mood: "neutral",
      onboarding_done: 0,
    };
    sql.upsertUser.run(u);
    u = sql.getUser.get(userId);
  }
  req.user = u;
  next();
});

/* ------------------------------------------------
 * Member A: Auth + Profile
 * ------------------------------------------------*/

// REGISTER
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email & password required" });
  }

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) {
    return res.status(409).json({ error: "email already exists" });
  }

  const id = nanoid();
  const hash = await bcrypt.hash(password, 10);

  sql.upsertUser.run({
    id,
    email,
    password_hash: hash,
    total_xp: 0,
    level: 1,
    current_streak: 0,
    longest_streak: 0,
    last_active_local_date: null,
    timezone: DEFAULT_TZ,
    avatar_tier: 0,
    theme_color: "#6C7EFF",
    daily_target: 1,
    goals_json: "[]",
    baseline_mood: "neutral",
    onboarding_done: 0,
  });

  const token = jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token });
});

// LOGIN
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!u) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const ok = await bcrypt.compare(password, u.password_hash || "");
  if (!ok) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const token = jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token });
});

// PROFILE
app.get("/api/me", (req, res) => {
  const u = sql.getUser.get(req.authUserId);
  res.json({
    id: u.id,
    email: u.email,
    onboardingDone: !!u.onboarding_done,
    prefs: {
      themeColor: u.theme_color,
      dailyTarget: u.daily_target,
      goals: JSON.parse(u.goals_json || "[]"),
      baselineMood: u.baseline_mood,
    },
  });
});

// SAVE PREFS
app.post("/api/me/prefs", (req, res) => {
  const { themeColor, dailyTarget, goals, baselineMood, onboardingDone } = req.body || {};
  const u = { ...sql.getUser.get(req.authUserId) };

  if (themeColor) u.theme_color = themeColor;
  if (Number.isInteger(dailyTarget)) u.daily_target = dailyTarget;
  if (Array.isArray(goals)) u.goals_json = JSON.stringify(goals);
  if (baselineMood) u.baseline_mood = baselineMood;
  if (onboardingDone === true) u.onboarding_done = 1;

  db.prepare(`
    UPDATE users SET
      theme_color=@theme_color,
      daily_target=@daily_target,
      goals_json=@goals_json,
      baseline_mood=@baseline_mood,
      onboarding_done=@onboarding_done
    WHERE id=@id
  `).run(u);

  res.json({ ok: true });
});

/* ------------------------------------------------
 * Member B: Quests + XP/Streak
 * ------------------------------------------------*/

app.get("/api/quests", (_req, res) => {
  res.json({ quests: sql.listQuests.all() });
});

app.get("/api/progress", (req, res) => {
  const u = sql.getUser.get(req.user.id);
  res.json({
    userId: u.id,
    totalXP: u.total_xp,
    level: u.level,
    currentStreak: u.current_streak,
    longestStreak: u.longest_streak,
    lastActiveDayISO: u.last_active_local_date,
    avatar: { tier: u.avatar_tier },
  });
});

app.post("/api/runs", (req, res) => {
  const u = { ...req.user };
  const { questId } = req.body || {};
  const q = sql.getQuest.get(questId);
  if (!q) return res.status(400).json({ error: "Invalid questId" });

  // cooldown check
  if (q.cooldown_sec > 0) {
    const last = sql.lastRunForQuest.get(u.id, questId);
    if (last) {
      const lastMs = new Date(last.created_at).getTime();
      const nowMs = Date.now();
      if (nowMs - lastMs < q.cooldown_sec * 1000) {
        const waitSec = Math.ceil((q.cooldown_sec * 1000 - (nowMs - lastMs)) / 1000);
        return res.status(429).json({ error: "Cooldown active", retryAfterSec: waitSec });
      }
    }
  }

  const prevLevel = u.level;
  applyStreakProgress(u);

  const mult = streakMultiplier(u.current_streak);
  const gainedXP = Math.round(q.base_points * mult);

  u.total_xp += gainedXP;
  u.level = computeLevel(u.total_xp);

  if (u.level > prevLevel && u.level % 5 === 0) {
    u.avatar_tier = (u.avatar_tier || 0) + 1;
  }

  const trx = db.transaction(() => {
    sql.upsertUser.run(u);
    sql.insertRun.run(
      nanoid(),
      u.id,
      questId,
      gainedXP,
      u.current_streak,
      new Date().toISOString(),
      localDateISO()
    );
  });
  trx();

  const fresh = sql.getUser.get(u.id);
  res.json({
    run: {
      userId: fresh.id,
      questId,
      gainedXP,
      streakApplied: fresh.current_streak,
    },
    progress: {
      totalXP: fresh.total_xp,
      level: fresh.level,
      currentStreak: fresh.current_streak,
      longestStreak: fresh.longest_streak,
      lastActiveDayISO: fresh.last_active_local_date,
      avatar: { tier: fresh.avatar_tier },
    },
    meta: {
      basePoints: q.base_points,
      streakMultiplier: mult,
      leveledUp: fresh.level > prevLevel,
    },
  });
});

app.get("/api/runs", (req, res) => {
  res.json({ runs: sql.listRunsByUser.all(req.user.id) });
});

/* ------------------------------------------------
 * Member C: Routines + Habit Logging
 * ------------------------------------------------*/

// List routines with today's count
app.get("/api/routines", (req, res) => {
  const userId = req.user.id;
  const today = localDateISO();

  const routines = db.prepare(`
    SELECT
      r.id,
      r.title,
      r.base_points,
      r.daily_target,
      r.active,
      COALESCE((
        SELECT COUNT(*)
        FROM routine_logs rl
        WHERE rl.routine_id = r.id
          AND rl.user_id = r.user_id
          AND rl.local_date = ?
      ), 0) AS countToday
    FROM routines r
    WHERE r.user_id = ?
      AND r.active = 1
    ORDER BY r.rowid DESC   -- safe even if created_at column doesn't exist
  `).all(today, userId);

  res.json({ routines });
});

// Create routine
app.post("/api/routines", (req, res) => {
  const userId = req.user.id;
  const { title, dailyTarget = 1, basePoints = 6 } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const id = nanoid();
  sql.insertRoutine.run(id, userId, title, Number(basePoints) || 6, Number(dailyTarget) || 1);

  const routine = sql.getRoutineById.get(id, userId);
  res.status(201).json({ routine });
});

// Log routine completion (+XP)
app.post("/api/routines/:id/log", (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  const routine = sql.getRoutineById.get(id, userId);
  if (!routine) return res.status(404).json({ error: "Routine not found" });

  const today = localDateISO();
  const { c } = sql.countRoutineLogsToday.get(id, userId, today);
  if (c >= routine.daily_target) {
    return res.status(400).json({ error: "Daily target already reached for this routine" });
  }

  const u = { ...req.user };
  const prevLevel = u.level;

  // Apply streak & XP (reuse same logic as quests)
  applyStreakProgress(u);
  const mult = streakMultiplier(u.current_streak);
  const gainedXP = Math.round(routine.base_points * mult);

  u.total_xp += gainedXP;
  u.level = computeLevel(u.total_xp);
  if (u.level > prevLevel && u.level % 5 === 0) {
    u.avatar_tier = (u.avatar_tier || 0) + 1;
  }

  const trx = db.transaction(() => {
    sql.upsertUser.run(u);
    sql.insertRoutineLog.run(nanoid(), id, userId, gainedXP, new Date().toISOString(), today);
  });
  trx();

  const fresh = sql.getUser.get(userId);

  res.json({
    log: { routineId: id, userId, gainedXP, localDate: today },
    progress: {
      totalXP: fresh.total_xp,
      level: fresh.level,
      currentStreak: fresh.current_streak,
      longestStreak: fresh.longest_streak,
      lastActiveDayISO: fresh.last_active_local_date,
      avatar: { tier: fresh.avatar_tier },
    },
  });
});

/* ------------------------------------------------
 * Member D: Weekly Insights + Risk Band
 * ------------------------------------------------*/
app.get("/api/insights/weekly", (req, res) => {
  const userId = req.user.id; // use the same identity as other routes

  // 7-day window (today inclusive)
  const today = dayjs().format("YYYY-MM-DD");
  const start = dayjs().subtract(6, "day").format("YYYY-MM-DD");

  const runs = db.prepare(
    `SELECT local_date, COUNT(*) as n, SUM(gained_xp) as xp
     FROM runs
     WHERE user_id=? AND local_date BETWEEN ? AND ?
     GROUP BY local_date`
  ).all(userId, start, today);

  const rlogs = db.prepare(
    `SELECT local_date, COUNT(*) as n
     FROM routine_logs
     WHERE user_id=? AND local_date BETWEEN ? AND ?
     GROUP BY local_date`
  ).all(userId, start, today);

  const routines = db.prepare(
    `SELECT id, daily_target FROM routines WHERE user_id=? AND active=1`
  ).all(userId);

  // Build day map
  const days = [];
  const byDay = {};
  for (let i = 6; i >= 0; i--) {
    const d = dayjs(today).subtract(i, "day").format("YYYY-MM-DD");
    days.push(d);
    byDay[d] = { date: d, quests: 0, routineLogs: 0, xp: 0 };
  }
  runs.forEach((r) => {
    const d = r.local_date;
    if (byDay[d]) {
      byDay[d].quests = Number(r.n) || 0;
      byDay[d].xp = Number(r.xp) || 0;
    }
  });
  rlogs.forEach((r) => {
    const d = r.local_date;
    if (byDay[d]) byDay[d].routineLogs = Number(r.n) || 0;
  });

  const dailyTargetTotal =
    routines.reduce((acc, r) => acc + (r.daily_target || 0), 0) || 0;

  let daysMetTarget = 0;
  let totalXP = 0;
  let totalQuests = 0;
  let totalRoutineLogs = 0;

  days.forEach((d) => {
    const row = byDay[d];
    totalXP += row.xp;
    totalQuests += row.quests;
    totalRoutineLogs += row.routineLogs;
    if (dailyTargetTotal > 0 && row.routineLogs >= dailyTargetTotal) {
      daysMetTarget++;
    }
  });

  const completionRate =
    dailyTargetTotal > 0 ? Math.round((daysMetTarget / 7) * 100) : 0;

  let riskBand = "Red";
  if (completionRate >= 70) riskBand = "Green";
  else if (completionRate >= 40) riskBand = "Amber";

  const u = sql.getUser.get(userId);

  res.json({
    window: { start, end: today },
    series: days.map((d) => byDay[d]),
    totals: { xp: totalXP, quests: totalQuests, routineLogs: totalRoutineLogs },
    completion: { dailyTargetTotal, daysMetTarget, completionRate },
    streak: { current: u.current_streak || 0, longest: u.longest_streak || 0 },
    riskBand,
    avatar: { tier: u.avatar_tier || 0 },
    avatarMood: riskBand === "Green" ? "happy" : riskBand === "Amber" ? "thoughtful" : "tired",
    message:
      riskBand === "Green"
        ? "Great balance this week — keep the momentum!"
        : riskBand === "Amber"
        ? "You’re on your way — a couple more logs to hit green!"
        : "Be gentle with yourself — start small today and build up 💛",
  });
});

/* ------------------------------------------------
 * Health check (handy for quick pings)
 * ------------------------------------------------*/
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------
 * Boot
 * ------------------------------------------------*/
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Evania XP/Streak backend (SQLite) listening on :${PORT}`);
});
