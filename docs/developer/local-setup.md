# Local Development Setup

## Prerequisites

- Node.js 22.13+ (the test suite uses `node:sqlite`, unflagged only from 22.13)
- npm
- Cloudflare account

## Setup

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum
npm install
npx wrangler login
npx wrangler d1 create stratum --local
npx wrangler d1 migrations apply stratum --local
npm run dev
```

Visit http://localhost:8787
