# SLIIT Parking System

A student parking and vehicle-pass management app built with Express, PostgreSQL (Supabase), Supabase Storage, and Vercel.

## Production

- Student portal: https://sliit-parking-beta.vercel.app/student/
- Admin portal: https://sliit-parking-beta.vercel.app/admin/
- Enforcer portal: https://sliit-parking-beta.vercel.app/enforcer/
- Health check: https://sliit-parking-beta.vercel.app/api/health

The production deployment is managed by Vercel and connected to this GitHub repository. Do not use a default or shared admin password. The first admin login initializes the admin account using the Vercel `ADMIN_PASSWORD` environment variable if no admin account exists.

## Stack

- Node.js 24
- Express
- Supabase Postgres
- Supabase Storage (private `payment-slips` bucket)
- JWT authentication with separate student, admin, and enforcer roles
- Vercel deployment

## Local development

1. Install Node.js 24.
2. Install dependencies: `npm install`.
3. Create a local `.env` file (never commit it) with:
   - `DATABASE_URL` — Supabase Postgres connection string.
   - `SUPABASE_URL` — project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — server-side service role key; keep secret.
   - `JWT_SECRET` — long, random signing secret.
   - `ADMIN_PASSWORD` — initial admin password.
4. Start the app: `npm start`.
5. Open the local portals at `/student/`, `/admin/`, and `/enforcer/`.

Use the Supabase database schema/migrations for the current Postgres schema. The application stores uploaded payment slips in the private Supabase Storage bucket; it does not use a local SQLite database or local uploads directory in production.

## Smoke tests

Run the read-only production smoke tests:

```bash
npm run test:smoke
```

By default, tests target the production URL above. To test another deployment:

```bash
BASE_URL=https://your-preview-url.vercel.app npm run test:smoke
```

The smoke suite checks that the public portals load, the health endpoint can reach Postgres and storage configuration, public student settings are returned, and protected student/admin/enforcer endpoints reject unauthenticated requests.

You can also run it from GitHub Actions using **Actions → Production smoke tests → Run workflow**. These checks do not create users, upload files, change settings, or approve payments.

## Main project files

- `server.js` — API routes, authentication, fee calculations, payment review, and pass creation.
- `public/student/index.html` — student registration, login, dashboard, payments, and pass view.
- `public/admin/index.html` — admin login, payment review, student/enforcer tables, and settings.
- `public/enforcer/index.html` — enforcer login, vehicle lookup, parking drafts, and fee completion.
- `public/style.css` — shared styling.
- `public/common.js` — shared frontend helpers.

## Security notes

- Never commit `.env`, database passwords, Supabase service-role keys, JWT secrets, or admin passwords.
- Rotate any database credential that has been pasted into a chat, issue, commit, or other shared location.
- Keep the Supabase Storage bucket private. Payment slips should be accessed through authenticated server routes.
- Use a strong, unique `JWT_SECRET` and `ADMIN_PASSWORD`.
