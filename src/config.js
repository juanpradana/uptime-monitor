import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'changeme',
  checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10),
  checkTimeoutMs: parseInt(process.env.CHECK_TIMEOUT_MS || '30000', 10),
  pruneDays: parseInt(process.env.PRUNE_DAYS || '7', 10),
  globalTelegramBotToken: process.env.GLOBAL_TELEGRAM_BOT_TOKEN || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
};
