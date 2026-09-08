# Cloudflare Workers deployment

Serotine uses the OpenNext Cloudflare adapter and Workers Static Assets.
See [README.md](README.md) for local database setup, testing, migration order,
production deployment, and the actual security model.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Build with `npm run build:edge`. Production deployment uses `npm run deploy`
after the remote D1 migrations are applied. Do not use `next-on-pages` or
`wrangler pages deploy` for this Worker project.
