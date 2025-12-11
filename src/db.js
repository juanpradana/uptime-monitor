import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'uptime.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  signup_ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'http' or 'ping'
  method TEXT DEFAULT 'GET', -- GET or POST
  target_url TEXT NOT NULL,
  post_body TEXT,
  is_public INTEGER DEFAULT 0,
  public_slug TEXT UNIQUE,
  telegram_chat_id TEXT,
  telegram_bot_token TEXT,
  heartbeat_token TEXT,
  heartbeat_last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checks_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  status INTEGER NOT NULL, -- 1=UP, 0=DOWN
  latency INTEGER,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);
`);

function ensureColumn(table, column, type) {
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

ensureColumn('monitors', 'heartbeat_token', 'TEXT');
ensureColumn('monitors', 'heartbeat_last_seen', 'DATETIME');

function seedAdmin() {
  if (!config.adminEmail || !config.adminPassword) return;
  const existing = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(config.adminEmail);
  if (existing) return;
  const passwordHash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare(
    'INSERT INTO users (email, password_hash, role, signup_ip) VALUES (?, ?, ?, ?)'
  ).run(config.adminEmail, passwordHash, 'admin', 'seed');
  console.log('[seed] Admin user created:', config.adminEmail);
}

seedAdmin();
