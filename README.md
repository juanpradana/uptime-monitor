# Uptime Monitor (SQLite + Express)

Aplikasi **self-hosted uptime monitor** berbasis Node.js + SQLite. Mendukung HTTP/HTTPS, ICMP ping, dan mode **heartbeat** (target memanggil callback). Termasuk dashboard Tailwind sederhana, halaman status publik, alert Telegram, serta pruning log otomatis.

## Fitur
- Registrasi & login berbasis JWT cookie; admin seeded via env.
- Limit **1 monitor per user** (non-admin) dan **1 akun per IP per 24 jam**.
- Tipe monitor: HTTP/HTTPS (GET/POST), Ping, Heartbeat (GET `/api/heartbeat/:token`).
- Alert Telegram saat status berubah (UP/DOWN); bisa pakai bot global atau token per monitor.
- Halaman status publik `/status/all` dan `/status/:slug` dengan riwayat (max 200 titik) dan filter rentang (`range=1 day|3 days|5 days|7 days|30 days`).
- Worker periodik dengan interval & timeout konfigurable; pruning otomatis log > N hari.

## Stack
- Node.js (Express, better-sqlite3)
- Frontend statis (Tailwind CDN)
- SQLite (file `data/uptime.db`)
- Cron (node-cron) untuk pruning

## Prasyarat
- **Node.js 18 atau 20 LTS** (disarankan 20 agar build `better-sqlite3` lebih mulus).
- npm.
- Tidak perlu server DB terpisah; SQLite disimpan di `data/uptime.db`.

## Instalasi & Menjalankan
1) Clone repo, lalu salin env:
```bash
cp .env.example .env
```
2) Isi variabel pada `.env` (lihat tabel di bawah).
3) Instal dependency:
```bash
npm install
```
4) Jalankan:
```bash
npm start   # server produksi sederhana
npm run dev # nodemon untuk hot reload
```
Server default di `http://localhost:3000`.

## Konfigurasi Environment
| Key | Default | Deskripsi |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP server |
| `JWT_SECRET` | `changeme` | Secret JWT |
| `CHECK_INTERVAL_SECONDS` | `60` | Interval cek monitor (detik) |
| `CHECK_TIMEOUT_MS` | `30000` | Timeout request (ms) |
| `PRUNE_DAYS` | `7` | Hapus log yang lebih lama dari N hari |
| `GLOBAL_TELEGRAM_BOT_TOKEN` | _(kosong)_ | Bot token global opsional |
| `ADMIN_EMAIL` | _(kosong)_ | Membuat admin saat boot jika diisi |
| `ADMIN_PASSWORD` | _(kosong)_ | Password admin seeded |

## Struktur Proyek
- `src/server.js` — routing API, status publik, heartbeat endpoint.
- `src/worker.js` — scheduler pengecekan, alert Telegram, pruning.
- `src/auth.js` — JWT + bcrypt helper, middleware auth/role.
- `src/db.js` — inisialisasi SQLite + migrasi kolom heartbeat + seed admin.
- `public/` — dashboard login/register, status publik (`status-all.html`, `status.html`).
- `data/uptime.db` — file database (dibuat otomatis).

## Alur Kerja
1) Worker jalan setiap `CHECK_INTERVAL_SECONDS`.  
2) Setiap monitor dieksekusi sesuai tipe: HTTP/HTTPS, Ping, atau Heartbeat (cek `heartbeat_last_seen`).  
3) Hasil dicatat ke `checks_log`; jika status berubah, alert Telegram dikirim.  
4) Cron harian (03:00) menghapus log lebih tua dari `PRUNE_DAYS`.  
5) Halaman publik & dashboard menarik data dari `/api/public` atau `/api/monitors`.

## API Ringkas
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- Monitors (butuh auth): `GET /api/monitors`, `POST /api/monitors`, `PUT /api/monitors/:id`, `DELETE /api/monitors/:id`.
- Status publik: `GET /api/public?range=1 day` dan `GET /api/public/:slug?range=7 days`.
- Heartbeat: `GET /api/heartbeat/:token` untuk menandai host **UP** (token per monitor).

Contoh heartbeat:
```bash
curl https://your-domain/api/heartbeat/XYZ123
```

## Catatan Batasan
- Pengguna non-admin: maksimal 1 monitor; admin tanpa batas.
- Registrasi dibatasi 1 IP / 24 jam.
- Riwayat per monitor dibatasi 200 titik per permintaan.
- Tidak ada lisensi eksplisit; tambahkan sesuai kebutuhan.

## Troubleshooting Singkat
- Masalah build `better-sqlite3`: pakai Node 20 LTS atau pastikan toolchain C++ terpasang.
- DB rusak/hilang: hapus `data/uptime.db` (data hilang) lalu jalankan ulang untuk rekreasi skema.
