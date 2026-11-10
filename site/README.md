# chatwarden.dev (the landing page)

A static React + Vite page for Chatwarden. It is a private workspace (`@chatwarden/site`), not a published package. Design
notes are in [DESIGN.md](./DESIGN.md).

Run everything from the repo root (it is an npm workspace) or from `site/`.

## Local development

```sh
npm ci                       # once, at the repo root
npm run dev --workspace site # http://localhost:5173, hot reload
```

## Test

```sh
npx playwright install chromium   # once: the CSP and accessibility tests drive a real browser
npm run test --workspace site
```

The tests cover the copy (every code line is a verbatim README line), the built page (no third-party host, no tracker, the
meta and OG tags, the 1200x630 OG image, `llms.txt` links that resolve to real repo paths, the `_headers` rules), the demo, and
a real-browser pass that loads the built page under the actual Content-Security-Policy and asserts zero violations, runs axe
(no serious or critical issues, both themes, phone and desktop) and checks the layout at several widths. A global setup builds
the kit packages the demo imports (`tsc -b` on core, matcher and store-memory, a no-op when up to date) and then `dist/`, once, before the files run.

## Build and preview

```sh
npm run build --workspace site     # builds the kit packages, renders the OG and icon PNGs, typechecks, then vite build -> site/dist
npm run preview --workspace site   # serves site/dist on http://localhost:4173
```

`npm run og --workspace site` re-renders `public/og.png`, `public/favicon-32.png` and `public/apple-touch-icon.png` on their own
(from `scripts/og.svg` and `public/favicon.svg`). The PNGs are committed, so a plain `vite build` ships them too.

What ships, and how it is served:

- Everything is same-origin: no third-party script, font, image or analytics. The two fonts are self-hosted and subset.
- `public/_headers` (Cloudflare Pages) sets a strict CSP (`default-src 'self'`, no inline script or style), `nosniff`, a
  referrer policy and a permissions policy, and caches `/assets/*` (hashed by Vite) as immutable for a year. HTML and the
  unhashed files keep the Pages default (revalidate on every load).
- The theme bootstrap is `public/theme-init.js`, a file, because the CSP forbids inline scripts.
- Measured on the production build: initial JS about 80 KB gzip, initial CSS about 6 KB gzip; the demo loads lazily
  (about 68 KB JS and 5 KB CSS gzip: the JS is the real Chatwarden kit, running in the visitor's browser). Lighthouse on mobile: 100 for performance, accessibility, best practices and SEO.

## Deploy (Cloudflare Pages)

Deploys are manual and run from a machine that is logged in to Cloudflare (`npx wrangler login`).

**Before the first deploy, release the kit.** The page links to packages on npm (`llms.txt` names
`@chatwarden/store-memory`, which 0.1.0 does not have), so tag and publish `v0.1.1` first (see `RELEASING.md`) and check:

```sh
npm view @chatwarden/store-memory version   # must print a version; a 404 means publish the kit first
```

```sh
npm run build --workspace site
npx wrangler pages deploy site/dist --project-name chatwarden --branch main
```

`--branch main` is what makes it a production deploy. Pages decides production or preview from the branch: the production
deployment is the one made from the project's production branch (`main`, set when the project was created). wrangler takes the
branch from git, so run from a worktree, a detached HEAD or any other branch, the deploy lands as a preview
(`<hash>.chatwarden-bvf.pages.dev`) and `chatwarden.dev` keeps saying there is no production deployment, with no error. Passing the
branch explicitly makes it production from anywhere. To check a build before it goes live, deploy it as a preview with another
branch name (`--branch preview`) and open the preview URL it prints.

One-time setup, in the Cloudflare dashboard (or with wrangler), before the first deploy:

1. **Create the Pages project** (done 2026-11-10; its pages.dev host is `chatwarden-bvf.pages.dev`). Workers & Pages, Create,
   Pages, "Direct Upload", name it `chatwarden`. (Or run, from `site/` (wrangler refuses to create a project from the workspace root),
   `npx wrangler pages project create chatwarden --production-branch main --force` once. wrangler 4.160 and later hand Pages
   commands to Workers unless `--force` is passed on that first create; later commands need no `--force`.) Do not connect a git repo: deploys are the
   command above.
2. **Add the custom domain.** In the project, Custom domains, Set up a custom domain, enter `chatwarden.dev`. Optionally add
   `www.chatwarden.dev` and redirect it to the apex.
3. **DNS.** If `chatwarden.dev` is a zone on this Cloudflare account, the dashboard's custom-domain flow creates the
   `CNAME` to `chatwarden-bvf.pages.dev` for you and issues the certificate. Adding the domain through the API (or a wrangler
   login, which has no DNS scope) does not create the record: the domain then waits with "CNAME record not set" until you add
   a proxied `CNAME` `chatwarden.dev` -> `chatwarden-bvf.pages.dev` in DNS, or press "Activate domain" in the project's Custom
   domains tab. If the domain is registered
   elsewhere, first add the domain to Cloudflare (Websites, Add a site) and point the registrar's nameservers at the two
   Cloudflare ones it shows, then do step 2.
4. Check `https://chatwarden.dev/`, `/og.png`, `/llms.txt` and `/robots.txt`, and look at the response headers once
   (`curl -sI https://chatwarden.dev/`) to see the CSP.

5. **Turn on HSTS in the dashboard** (SSL/TLS, Edge Certificates, HTTP Strict Transport Security, and "Always Use HTTPS"), for
   `chatwarden.dev`. It is deliberately not in `public/_headers`: Pages sends `_headers` on every preview URL too
   (`<hash>.chatwarden-bvf.pages.dev`), and a preview host should not get an HSTS policy. Start with a short max-age and raise it
   once the site has been fine for a while.

6. **Leave Cloudflare's script injectors off.** Do not turn on Web Analytics (the one-click Pages option or the zone's beacon),
   Rocket Loader or email address obfuscation for this project or zone. They inject scripts, the CSP blocks them (console
   errors), and Web Analytics would contradict "no analytics".

Later deploys are only the build and the deploy command above. Each deploy gets a preview URL (`<hash>.chatwarden-bvf.pages.dev`);
a production deploy also goes to the production alias.

`/` is the only route and there is no `404.html`, so Pages serves `index.html` for unknown paths (with a 200). That is fine for
a single-page site: the page's canonical link points at `/`, and `/robots.txt`, `/llms.txt`, `/sitemap.xml` and `/og.png` are real
files. Add a `public/404.html` (no inline script or style, because of the CSP) if real 404s are ever wanted.

The CI step that fails when the OG and icon PNGs differ (the PNG drift guard) has not run on Linux yet: the committed PNGs were
rendered on Windows, so CI is the first run on Linux. If it fails there, run `npm run og --workspace site` on Linux (or take the
PNGs from the CI artifact), commit them, or relax the guard to a size check.

## Changing the content

- Words live in `src/content.ts`. Code samples and install commands must stay verbatim lines of a package README; the tests
  fail if they drift.
- If you add a package, add its README and npm link to `public/llms.txt`.
- The only demo words are the invented ones from `@chatwarden/matcher/fixtures`. Never put a real slur anywhere in the site.
