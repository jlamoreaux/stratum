---
title: OpenAPI specification
description: The complete, machine-readable Stratum REST API specification.
---

The complete REST API surface is described by an OpenAPI 3 specification. The
source of truth lives in the repository at
[`docs/api/openapi.yml`](https://github.com/stratum-eng/stratum/blob/main/docs/api/openapi.yml)
and is published with this site:

- **[Download `openapi.yml`](/openapi.yml)**

Point any OpenAPI tooling at it — Swagger UI, Redoc, Postman/Insomnia imports,
or client generators such as `openapi-generator` and `openapi-typescript`.

```bash
# Generate TypeScript types for the API
npx openapi-typescript https://docs.usestratum.dev/openapi.yml -o stratum-api.d.ts
```
