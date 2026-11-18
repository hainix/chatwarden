The Chatwarden service
======================
1. Copy .env.example to .env and fill in the three variables (a value: openssl rand -base64 32).
2. Build and run it: docker compose up --build
3. Ask it something: curl -H "Authorization: Bearer YOUR_SERVICE_KEY" http://127.0.0.1:8787/v1
4. The moderator hub is at http://127.0.0.1:8787/mod, with CHATWARDEN_ADMIN_TOKEN as the sign-in. The sign-in cookie is Secure (Chrome and Firefox accept it on 127.0.0.1; for a browser that does not, add CHATWARDEN_INSECURE_STAFF_COOKIE=1 under environment in compose.yaml, for local use only).
5. profile.json is the standard it runs by; edit it and rebuild. Room contexts and reserved names go in it.
6. The word list is a placeholder: the service says so (synthetic_terms in the GET /v1 answer) until you give it a terms file.
7. The memory store keeps nothing: everything is lost on restart.
8. Put a TLS proxy or a private network in front before you expose port 8787. A service key is a database password.
9. Rotate a key by adding the new one beside the old, deploying it to your game servers, then removing the old one.
10. The API is described by: chatwarden serve --print-openapi
11. The image is built here, from your own folder: nothing is pushed anywhere.
12. Written by `chatwarden init --service`. It is yours now: edit freely. Re-running never overwrites a file you changed.
