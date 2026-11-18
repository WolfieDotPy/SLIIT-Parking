Supabase + Vercel deployment notes

The application uses SQLite when DATABASE_URL is unset and PostgreSQL when DATABASE_URL is set. The production runtime uses Supabase PostgreSQL and the private payment-slips storage bucket. The six application tables already exist in Supabase; the application does not drop, truncate or recreate existing tables.

Portal HTML is stored in portal-pages/ rather than public/ so Vercel's static CDN cannot serve the admin or enforcer page before the Express hostname gate runs. Public CSS, JavaScript and logo assets remain in public/.

Use the three project domains:
- sliit-parking-beta.vercel.app (student)
- sliit-parking-admin.vercel.app (admin)
- sliit-parking-enforcer.vercel.app (enforcer)

A preview deployment's own VERCEL_URL is treated as a student preview host. The named admin and enforcer portal hostnames remain production-only until explicitly overridden with ADMIN_PORTAL_HOSTS / ENFORCER_PORTAL_HOSTS.

Required production environment variables: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, ADMIN_PASSWORD (first bootstrap only). The service-role key and database URL must remain server-side.
