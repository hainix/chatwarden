---
"@chatwarden/hub-react": patch
---

The hub's `fetchTransport` now sends `content-type: application/json` on every write (POST, PUT, PATCH, DELETE), including the ones with no body: releasing a case, claiming one, taking the next one, and saying who is viewing. Before, those went out with no content type. That means your server can refuse any write that does not say JSON, a simple guard against cross-site request forgery: a form on another site cannot send that type without a CORS preflight. The kit reads an empty body as no body whatever its type, so nothing changes on the kit's side. A content type you set yourself in `headers` is kept.
