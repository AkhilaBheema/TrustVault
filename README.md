# TrustVault

TrustVault is a role-based document workspace with encrypted storage, explicit access grants, expiring share invitations, access request workflows, and an append-only audit trail.

## Local setup

1. Copy `.env.example` to `.env`. Set a valid `DATABASE_URL`, a 64-character hex `MASTER_KEY`, a private `SESSION_SECRET` of at least 32 characters, `CORS_ORIGIN`, and the initial administrator's organization, email, name, and password. The password must be at least 12 characters. In production, the service fails fast when any required secret or database setting is missing.
2. Start the local stack with `docker compose up --build`.
3. Open [http://localhost:5173](http://localhost:5173) and sign in with the administrator account from `.env`.

If Docker is not installed, start PostgreSQL locally and ensure the database in
`DATABASE_URL` is listening on port 5432 before running `npm run backend:dev`.
In development only, the backend falls back to an embedded PGlite database when
PostgreSQL is unavailable; this fallback is never used when `NODE_ENV=production`.
After installing PostgreSQL on Windows, run
`powershell -ExecutionPolicy Bypass -File .\scripts\setup-postgres.ps1 -PostgresPassword '<the password chosen during installation>'`
to create the TrustVault role and database.

The backend applies database migrations at startup and provisions the configured administrator only when the database has no users. Existing workspaces are left intact. To provision the first account manually against `DATABASE_URL`, run `npm run db:seed` from the repository root.

For a manual setup, start PostgreSQL, install dependencies with `npm ci`, `npm --prefix backend ci`, and `npm --prefix frontend ci`, then run `npm run db:migrate`, `npm run db:seed`, `npm run backend:dev`, and `npm run frontend:dev` in separate terminals. The Vite server proxies `/api` to `http://localhost:4000`.

## Role workflows

- **Administrator:** manage workspace accounts, review account activity and security signals, and verify or export the audit chain. Administrators do not gain document access by role.
- **Owner:** upload documents and versions, issue and revoke grants, create recipient-bound expiring invitation links, review access requests, and inspect permission suggestions.
- **Viewer:** browse documents explicitly shared with them, download through short-lived tickets, submit access requests, and track each request's status.

## Validation

Automated backend tests use isolated in-memory databases and fixtures under `backend/tests/helpers/`. The production seed creates only the configured first administrator; it does not add sample accounts, files, grants, or activity.

```bash
npm run backend:test
npm run frontend:build
npm run backend:build
```

## Deployment

The repository includes [`vercel.json`](./vercel.json) and [`render.yaml`](./render.yaml) for a split Vercel and Render deployment.

1. Create the Render Blueprint and set `MASTER_KEY`, `CORS_ORIGIN`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME`, and `INITIAL_ADMIN_PASSWORD` in the service settings. Use a unique 64-character hex master key and a strong initial password.
2. Render provisions PostgreSQL, runs migrations, and provisions the administrator when the database is empty.
3. Deploy the frontend on Vercel with the repository root as its project root. Keep `VITE_API_URL` unset so `/api/*` uses the same-origin proxy configured in `vercel.json`.

## Security model

- Every document operation passes through a default-deny authorization service.
- Document queries and administrative activity are scoped to the user's organization.
- Downloads use single-use, short-lived tickets and recheck authorization when streamed.
- Files use AES-256-GCM encryption with per-file data keys and a verified plaintext digest before download or preview.
- Audit events form a SHA-256 chain over every immutable event field; database triggers block mutation of recorded events.

## Project structure

```text
backend/src/       Fastify API, authorization, and persistence services
backend/tests/     API tests and isolated test fixtures
frontend/src/      React application and API client
db/migrations/    Database schema migrations
db/seed.ts         Configured first-administrator provisioning
docs/              Permission and security documentation
```
