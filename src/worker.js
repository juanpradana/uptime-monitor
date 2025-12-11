import axios from 'axios';
import ping from 'ping';
import cron from 'node-cron';
import { config } from './config.js';
import { db } from './db.js';

function sendTelegram({ token, chatId, text }) {
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  axios
    .post(url, { chat_id: chatId, text }, { timeout: 5000 })
    .catch((err) => console.error('[telegram] failed', err.message));
}

async function checkHttp(monitor) {
  const start = Date.now();
  try {
    const resp = await axios({
      url: monitor.target_url,
      method: monitor.method || 'GET',
      data: monitor.post_body ? JSON.parse(monitor.post_body) : undefined,
      timeout: config.checkTimeoutMs,
      validateStatus: () => true,
    });
    const latency = Date.now() - start;
    const status = resp.status >= 200 && resp.status < 300 ? 1 : 0;
    return { status, latency };
  } catch (err) {
    return { status: 0, latency: Date.now() - start };
  }
}

async function checkPing(monitor) {
  const start = Date.now();
  try {
    const res = await ping.promise.probe(monitor.target_url, {
      timeout: Math.ceil(config.checkTimeoutMs / 1000),
    });
    const latency = res.time === 'unknown' ? null : Math.round(res.time);
    const status = res.alive ? 1 : 0;
    return { status, latency };
  } catch (_err) {
    return { status: 0, latency: Date.now() - start };
  }
}

function checkHeartbeat(monitor) {
  const last = monitor.heartbeat_last_seen
    ? Date.parse(`${monitor.heartbeat_last_seen}Z`)
    : null;
  const now = Date.now();
  const age = last ? now - last : null;
  const threshold = config.checkIntervalSeconds * 2 * 1000;
  const status = last && age <= threshold ? 1 : 0;
  const latency = age !== null ? age : null;
  return Promise.resolve({ status, latency });
}

async function performCheck(monitor) {
  const prev = db
    .prepare(
      'SELECT status FROM checks_log WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1'
    )
    .get(monitor.id);
  const runner =
    monitor.type === 'ping' ? checkPing : monitor.type === 'heartbeat' ? checkHeartbeat : checkHttp;
  const { status, latency } = await runner(monitor);
  db.prepare(
    'INSERT INTO checks_log (monitor_id, status, latency) VALUES (?, ?, ?)'
  ).run(monitor.id, status, latency ?? null);

  if (prev?.status !== status) {
    const token = monitor.telegram_bot_token || config.globalTelegramBotToken;
    if (token && monitor.telegram_chat_id) {
      const text =
        status === 1
          ? `✅ ${monitor.name} is UP`
          : `❌ ${monitor.name} is DOWN`;
      sendTelegram({ token, chatId: monitor.telegram_chat_id, text });
    }
  }
}

let running = false;

async function runAllChecks() {
  if (running) return;
  running = true;
  try {
    const monitors = db
      .prepare('SELECT * FROM monitors ORDER BY created_at DESC')
      .all();
    for (const monitor of monitors) {
      await performCheck(monitor);
    }
  } catch (err) {
    console.error('[worker] failed', err);
  } finally {
    running = false;
  }
}

export function scheduleChecks() {
  runAllChecks(); // initial
  setInterval(runAllChecks, config.checkIntervalSeconds * 1000);
}

export function schedulePrune() {
  cron.schedule('0 3 * * *', () => {
    const days = config.pruneDays;
    db.prepare(
      'DELETE FROM checks_log WHERE checked_at < datetime("now", ?)'
    ).run(`-${days} days`);
    console.log('[prune] old logs removed');
  });
}
