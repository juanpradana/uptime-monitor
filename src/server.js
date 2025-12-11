import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { db } from './db.js';
import {
  hashPassword,
  verifyPassword,
  issueAuth,
  requireAuth,
  requireRole,
  findUserByEmail,
  findUserById,
} from './auth.js';
import { scheduleChecks, schedulePrune } from './worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const RANGE_MAP = {
  '1 day': '-1 day',
  '3 days': '-3 day',
  '5 days': '-5 day',
  '7 days': '-7 day',
  '30 days': '-30 day',
};

function resolveRange(value) {
  return RANGE_MAP[value] || '-1 day';
}

const app = express();
app.set('trust proxy', true);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    check_interval_seconds: config.checkIntervalSeconds,
    check_timeout_ms: config.checkTimeoutMs,
    prune_days: config.pruneDays,
  })
);

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip || 'unknown';
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const recent = db
    .prepare(
      "SELECT id FROM users WHERE signup_ip = ? AND created_at >= datetime('now', '-1 day')"
    )
    .get(ip);
  if (recent) {
    return res
      .status(429)
      .json({ error: 'Registration limit reached for this IP in last 24h' });
  }
  const existing = findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const passwordHash = hashPassword(password);
  const info = db
    .prepare(
      'INSERT INTO users (email, password_hash, role, signup_ip) VALUES (?, ?, ?, ?)'
    )
    .run(email, passwordHash, 'user', ip);
  const user = findUserById(info.lastInsertRowid);
  issueAuth(res, user);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  issueAuth(res, user);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/monitors', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const monitors = isAdmin
    ? db.prepare('SELECT * FROM monitors').all()
    : db.prepare('SELECT * FROM monitors WHERE user_id = ?').all(req.user.id);
  const logStmt = db.prepare(
    'SELECT status, latency, checked_at FROM checks_log WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1'
  );
  const enriched = monitors.map((m) => {
    const last = logStmt.get(m.id);
    return {
      ...m,
      last_status: last?.status ?? null,
      last_latency: last?.latency ?? null,
      last_checked_at: last?.checked_at ?? null,
    };
  });
  res.json({ monitors: enriched });
});

function ensureOwnership(req, monitor) {
  if (req.user.role === 'admin') return true;
  return monitor.user_id === req.user.id;
}

app.post('/api/monitors', requireAuth, (req, res) => {
  const body = req.body || {};
  const { name, type, method = 'GET', target_url } = body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!['http', 'ping', 'heartbeat'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  if (type === 'ping' && method !== 'GET') {
    return res.status(400).json({ error: 'Ping monitors do not support this method' });
  }
  if (type === 'heartbeat') {
    body.target_url = null;
  } else if (!target_url) {
    return res.status(400).json({ error: 'target_url is required for http/ping' });
  }

  if (req.user.role !== 'admin') {
    const count = db
      .prepare('SELECT COUNT(*) as c FROM monitors WHERE user_id = ?')
      .get(req.user.id).c;
    if (count >= 1) {
      return res
        .status(400)
        .json({ error: 'Quota reached: only 1 monitor allowed for standard users' });
    }
  }

  const isPublic = body.is_public ? 1 : 0;
  const slug = body.public_slug || nanoid(10);
  const heartbeatToken = body.heartbeat_token || nanoid(12);
  try {
    const info = db
      .prepare(
        `INSERT INTO monitors
        (user_id, name, type, method, target_url, post_body, is_public, public_slug, telegram_chat_id, telegram_bot_token, heartbeat_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        name,
        type,
        method,
        type === 'heartbeat' ? 'heartbeat' : target_url,
        body.post_body || null,
        isPublic,
        slug,
        body.telegram_chat_id || null,
        body.telegram_bot_token || null,
        heartbeatToken
      );
    const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(info.lastInsertRowid);
    res.json({ monitor });
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: monitors.public_slug')) {
      return res.status(409).json({ error: 'Slug already exists, try again' });
    }
    return res.status(500).json({ error: 'Failed to create monitor' });
  }
});

app.put('/api/monitors/:id', requireAuth, (req, res) => {
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  if (!ensureOwnership(req, monitor)) return res.status(403).json({ error: 'Forbidden' });

  const body = req.body || {};
  const fields = {
    name: body.name ?? monitor.name,
    type: body.type ?? monitor.type,
    method: body.method ?? monitor.method,
    target_url: body.target_url ?? monitor.target_url,
    post_body: body.post_body ?? monitor.post_body,
    is_public: body.is_public !== undefined ? (body.is_public ? 1 : 0) : monitor.is_public,
    public_slug: body.public_slug ?? monitor.public_slug,
    telegram_chat_id: body.telegram_chat_id ?? monitor.telegram_chat_id,
    telegram_bot_token: body.telegram_bot_token ?? monitor.telegram_bot_token,
  };
  if (!['http', 'ping', 'heartbeat'].includes(fields.type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  if (fields.type === 'ping') {
    fields.method = 'GET';
    fields.post_body = null;
  }
  if (fields.type === 'heartbeat') {
    fields.method = 'GET';
    fields.post_body = null;
    fields.target_url = 'heartbeat';
    fields.heartbeat_token = fields.heartbeat_token || monitor.heartbeat_token || nanoid(12);
  }
  try {
    db.prepare(
      `UPDATE monitors SET
      name = @name,
      type = @type,
      method = @method,
      target_url = @target_url,
      post_body = @post_body,
      is_public = @is_public,
      public_slug = @public_slug,
      telegram_chat_id = @telegram_chat_id,
      telegram_bot_token = @telegram_bot_token,
      heartbeat_token = @heartbeat_token
      WHERE id = @id`
    ).run({ ...fields, id: monitor.id });
    const updated = db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitor.id);
    res.json({ monitor: updated });
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: monitors.public_slug')) {
      return res.status(409).json({ error: 'Slug already exists, try again' });
    }
    res.status(500).json({ error: 'Failed to update monitor' });
  }
});

app.delete('/api/monitors/:id', requireAuth, (req, res) => {
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  if (!ensureOwnership(req, monitor)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM monitors WHERE id = ?').run(monitor.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireRole('admin'), (_req, res) => {
  const users = db
    .prepare('SELECT id, email, role, signup_ip, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json({ users });
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/public/:slug', (req, res) => {
  const range = resolveRange(req.query.range);
  const monitor = db
    .prepare('SELECT * FROM monitors WHERE public_slug = ? AND is_public = 1')
    .get(req.params.slug);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const last = db
    .prepare(
      'SELECT status, latency, checked_at FROM checks_log WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1'
    )
    .get(monitor.id);
  const history = db
    .prepare(
      "SELECT status, latency, checked_at FROM checks_log WHERE monitor_id = ? AND checked_at >= datetime('now', ?) ORDER BY checked_at ASC LIMIT 200"
    )
    .all(monitor.id, range);
  const upCount = history.filter((r) => r.status === 1).length;
  const uptime = history.length > 0 ? Math.round((upCount / history.length) * 100) : null;
  res.json({
    monitor: {
      name: monitor.name,
      is_public: true,
      slug: monitor.public_slug,
    },
    current: last
      ? { status: last.status, latency: last.latency, checked_at: last.checked_at }
      : null,
    uptime_24h: uptime,
    history,
  });
});

app.get('/api/public', (_req, res) => {
  const range = resolveRange(_req.query.range);
  const monitors = db
    .prepare('SELECT id, name, type, public_slug FROM monitors WHERE is_public = 1')
    .all();
  const lastStmt = db.prepare(
    'SELECT status, latency, checked_at FROM checks_log WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1'
  );
  const histStmt = db.prepare(
    "SELECT status, latency, checked_at FROM checks_log WHERE monitor_id = ? AND checked_at >= datetime('now', ?) ORDER BY checked_at DESC LIMIT 200"
  );
  const last24Stmt = db.prepare(
    "SELECT status FROM checks_log WHERE monitor_id = ? AND checked_at >= datetime('now', ?)"
  );
  const payload = monitors.map((m) => {
    const last = lastStmt.get(m.id);
    const historyDesc = histStmt.all(m.id, range);
    const history = historyDesc.reverse(); // oldest first
    const lastRange = last24Stmt.all(m.id, range);
    const upCount = lastRange.filter((r) => r.status === 1).length;
    const uptime = lastRange.length > 0 ? Math.round((upCount / lastRange.length) * 100) : null;
    return {
      name: m.name,
      type: m.type,
      slug: m.public_slug,
      last_status: last?.status ?? null,
      last_latency: last?.latency ?? null,
      last_checked_at: last?.checked_at ?? null,
      uptime_24h: uptime,
      history,
    };
  });
  res.json({ monitors: payload });
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/register', (_req, res) => {
  res.sendFile(path.join(publicDir, 'register.html'));
});

// Heartbeat: host calls this endpoint to mark itself UP
app.get('/api/heartbeat/:token', (req, res) => {
  const token = req.params.token;
  const monitor = db
    .prepare('SELECT * FROM monitors WHERE heartbeat_token = ? AND type = ?')
    .get(token, 'heartbeat');
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  db.prepare(
    "UPDATE monitors SET heartbeat_last_seen = datetime('now') WHERE id = ?"
  ).run(monitor.id);
  res.json({ ok: true, monitor: { id: monitor.id, name: monitor.name } });
});

app.use(express.static(publicDir));
app.get('/status/all', (_req, res) => {
  res.sendFile(path.join(publicDir, 'status-all.html'));
});
app.get('/status/:slug', (_req, res) => {
  res.sendFile(path.join(publicDir, 'status.html'));
});

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  scheduleChecks();
  schedulePrune();
});
