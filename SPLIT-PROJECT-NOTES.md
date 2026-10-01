# Social Census — Loomic Split Project

Purpose: **Analytics & reporting**.

## Shared Loomic data
To see the same clients, team members and connected social accounts as the current Loomic tool, configure the same `DATABASE_URL`/database and the same OAuth/provider environment variables in this project's `.env`.

## Independent deployment
This is a standalone Next.js project with its own package name, local auth-token key and default local port. It can be deployed to a separate Vercel/project/domain without changing Loomic.

## Important
The `.env` file from the uploaded source is deliberately not included in this package. Copy your own Loomic environment values into a new `.env` or your hosting provider's environment settings. This avoids packaging secrets into downloadable ZIPs.
