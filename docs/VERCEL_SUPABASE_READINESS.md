# Supabase + Vercel migration status

## Current state

This branch is a migration work branch. The Supabase project exists and currently contains the six application tables:

- users
- vehicles
- passes
- fees
- payments
- settings

The `payment-slips` Storage bucket is private. RLS is enabled on the six tables, and direct `anon` / `authenticated` table privileges were revoked. The intended model is that the Express server is the only trusted database/storage client and uses server-only credentials.

## Important: deployment is not ready yet

The current `server.js` is still the original SQLite implementation. It imports `node:sqlite`, writes to a local `sliit-parking.db`, stores payment slips in a local `uploads/` directory, and does not export an Express app for Vercel's function runtime. Vercel's serverless filesystem is not a durable database or file store.

The repository also currently contains only root-level `index.html`, `common.js`, and `style.css`; the existing server expects a `public/` directory and redirects to portal paths that are not present in the repository tree. This needs to be reconciled before a working public deployment can be claimed.

Do not deploy this branch as a production app until all of the following are completed:

1. Replace every SQLite operation with asynchronous PostgreSQL queries using parameterized SQL.
2. Preserve the existing API routes and response contracts while converting transaction flows to real PostgreSQL transactions.
3. Move multipart uploads to memory storage and payment slips to the private Supabase Storage bucket. Store object paths, not local filenames.
4. Authorize every slip download on the server before returning a short-lived signed URL or streaming the object.
5. Export the Express app from a Vercel function entry point; do not call `listen()` in the serverless module.
6. Reconcile the static portal routes and actual checked-in frontend files.
7. Add automated smoke tests for student, admin, and enforcer flows, plus upload authorization.
8. Verify the production build and function logs after deployment.

## Required Vercel environment variables

Set these in Vercel Project Settings -> Environment Variables. Use Production, Preview, and Development scopes as appropriate.

- `NODE_ENV=production`
- `JWT_SECRET`: a long random secret, unique to this deployment.
- `DATABASE_URL`: the Supabase PostgreSQL **Transaction Pooler** connection URI copied from the Supabase dashboard. Do not guess the host, port, username, or password.
- `SUPABASE_URL=https://pkcqeqplgslmgxdmvqti.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: the project's server-side service-role/secret key. Never put this in browser code, a `NEXT_PUBLIC_*` variable, or Git.
- `ADMIN_PASSWORD`: required only if the application needs to bootstrap the first admin. Set a strong value before first boot.

The browser must never receive `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`.

## Connecting the GitHub repository to Vercel

1. Sign in to Vercel and choose **Add New -> Project**.
2. Import `WolfieDotPy/SLIIT-Parking` from GitHub.
3. Select branch `feat/supabase-vercel-migration` for a preview deployment.
4. Do not override the build/output settings until the Vercel function entry point and static routing are implemented.
5. Add the environment variables above only after the server migration is complete.
6. Deploy a Preview first, test the three portals and protected uploads, then promote to Production.

This is a checklist, not a claim that Vercel is connected or that a deployment has succeeded.
