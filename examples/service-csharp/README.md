# Chatwarden service API: a C# sample

A small client (`ChatwardenClient.cs`, about 150 lines over `HttpClient` and `System.Text.Json`, no other dependency) and a demo (`Program.cs`) that runs the whole conversation
of `examples/service/curl.sh` against a running service and exits 1 on any surprise. It is a sample to copy from, not a package.

```
cd examples/service-csharp
BASE=http://127.0.0.1:8787 KEY=<a service key> dotnet run
```

What the client does for you: it sends the service key as the bearer, an `Idempotency-Key` on a line and a report (so a retry is judged once), waits for `Retry-After` on a 429,
retries a network error or a 5xx a few times with a growing wait, and never retries another 4xx. A refusal is an answer (status 200, `ok: false`); a refusal reason it does not
know is `"unknown"`, because the API only ever adds reasons. Keep the service key in your server's environment, never in a client build.

The demo reads `examples/service/expectations.json`, the file `conformance.mjs` reads too, so the two clients are held to the same words. CI builds this folder and runs it against
a started `chatwarden serve`. `examples/service-csharp/routes.test.ts` checks that every path the client uses is in the API description (`chatwarden serve --print-openapi`).

Not here: the staff side (the hub) and the player routes. The service API has no player routes: your game draws its own chat box and notice screen.
