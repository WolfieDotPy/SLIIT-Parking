# SLIIT Parking System

A three-portal parking and vehicle-pass system for SLIIT. The original student, admin and enforcer interfaces are retained. The same Express application supports SQLite for local development and Supabase PostgreSQL + Supabase Storage for production.

## Portals

Production domains:

- Student: https://sliit-parking-beta.vercel.app
- Admin: https://sliit-parking-admin.vercel.app
- Enforcer: https://sliit-parking-enforcer.vercel.app

Each domain only serves its matching portal and matching API namespace. The backend checks the hostname before handling page or API requests, and the APIs also enforce the signed-in account role.

## Local development (SQLite)

Requirements: Node.js 24.x.

```bash
npm install
npm start
```

Open:

- Student: http://localhost:3000/student/
- Admin: http://localhost:3000/admin/
- Enforcer: http://localhost:3000/enforcer/

When `DATABASE_URL` is not set, the app creates `sliit-parking.db` in the project directory and stores uploaded payment slips under `uploads/`. For local first run only, the fallback admin password is `admin123`; change it immediately in Admin → Settings, or set `ADMIN_PASSWORD` before starting the server. Set a private `JWT_SECRET` even for local use.

Optional local environment settings:

```bash
JWT_SECRET=your-long-random-secret
ADMIN_PASSWORD=your-local-admin-password
SQLITE_PATH=./sliit-parking.db
PORT=3000
```

## Production (Vercel + Supabase)

Vercel runs the Express app and Supabase PostgreSQL stores the application data. Payment slips are stored in the private Supabase Storage bucket `payment-slips`.

Configure these server-side Vercel environment variables for Production, Preview and Development as appropriate:

- `DATABASE_URL`: Copy the Supabase **Transaction pooler** connection string from Project → Connect → Transaction pooler (port 6543). It is intended for serverless functions. The app defaults to a one-connection `pg` pool per Vercel instance; adjust `PG_POOL_SIZE` only after measuring queueing.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only Supabase secret/service-role key. Never expose it in browser code.
- `SUPABASE_STORAGE_BUCKET`: optional; defaults to `payment-slips`.
- `JWT_SECRET`: long, random signing secret.
- `ADMIN_PASSWORD`: initial admin password, used only if the database does not yet contain an admin account.

The production app never falls back to SQLite. On Vercel, missing `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `JWT_SECRET` causes startup to fail rather than silently using local storage or a predictable signing key. Do not commit real `.env` files or secrets.

The three hostnames can be overridden with comma-separated `STUDENT_PORTAL_HOSTS`, `ADMIN_PORTAL_HOSTS`, and `ENFORCER_PORTAL_HOSTS` variables. Static shared assets (CSS, common JavaScript and logos) are public; portal HTML is served from outside `public/` so it cannot bypass the hostname check through Vercel's static CDN.

## Main features

### Students

- Register with a 10-character student ID, student/contact details and vehicle information.
- Registration does not require a payment slip. The QR/pass image remains inactive until a vehicle-pass payment is approved.
- View and download the vehicle-pass QR image, check validity and outstanding fees, view payment history, and submit payment slips for passes or parking fees.

### Admin

- Review, approve or reject submitted payment slips.
- View student and enforcer details, search records, register enforcers, and configure rates, grace period, pass length and bank information.
- Database tools for Students, Enforcers, Vehicles, Passes, Fees and Payments: search, edit, delete, CSV export, and bulk Excel/CSV import using the provided templates.
- Grant a vehicle pass manually and download a database backup. Local mode downloads the SQLite database file; production mode exports a JSON backup of the six PostgreSQL tables.

### Enforcers

- Scan a QR code or search by student ID / vehicle registration.
- Start a parking-fee draft when a vehicle enters, then finish it with the exit time.
- Fees use the configured free grace period and hourly rate. Vehicles with an active pass cannot be charged a parking fee through the enforcer workflow.
- View draft, pending and unpaid fee records associated with the signed-in enforcer.

## Data model

The six application tables are `users`, `vehicles`, `passes`, `payments`, `fees` and `settings`. The production Supabase project already contains these tables and their current data model. The application initialization uses `CREATE TABLE IF NOT EXISTS` for new installations and does not drop or truncate existing records.

## Backups

- Local SQLite: stop the server and copy `sliit-parking.db` plus the `uploads/` directory.
- Production: Admin → Database → Download full backup exports the six PostgreSQL tables as JSON. Payment slip objects remain in the private Supabase Storage bucket and should be backed up separately using Supabase Storage/export tooling.

## Project structure

- `server.js` — Express routes, SQLite/PostgreSQL adapter, authentication, fee calculation, imports and backups.
- `portal-pages/` — original portal HTML. Kept outside `public/` to enforce domain-level routing.
- `public/style.css`, `public/common.js` — shared original styling and browser helpers.
- `public/logo.png`, `public/logo-uni.png` — SLIIT crest and pass header logo.
- `tests/smoke.test.js` — read-only production smoke and portal-isolation tests.

## Checks

```bash
npm run check
npm run test:smoke
```

`test:smoke` checks all three portal domains, public student settings, unauthenticated API protections and cross-portal denials. It does not create student accounts, upload slips or approve payments.
