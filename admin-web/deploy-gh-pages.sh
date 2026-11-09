#!/usr/bin/env bash
# Builds the admin panel and publishes it to the `gh-pages` branch of this
# repository (GitHub Pages: Settings → Pages → Deploy from a branch → gh-pages / root).
# Uses only the public values in .env.production. Refuses to run with a secret key.
set -euo pipefail
cd "$(dirname "$0")"
grep -qE 'sb_secret_|service_role' .env.production && { echo "Secret key in .env.production — aborting"; exit 1; }
npm run build
touch dist/.nojekyll
REPO_ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d)
git -C "$REPO_ROOT" worktree add --force --detach "$TMP" >/dev/null
(
  cd "$TMP"
  git checkout --orphan gh-pages-tmp >/dev/null 2>&1
  git rm -rf --quiet . >/dev/null 2>&1 || true
  cp -r "$OLDPWD/dist/." .
  git add -A
  git commit --quiet -m "Deploy EKO Store admin panel $(date -u +%Y-%m-%dT%H:%MZ)"
  git push --force origin HEAD:gh-pages
)
git -C "$REPO_ROOT" worktree remove --force "$TMP"
git -C "$REPO_ROOT" branch -D gh-pages-tmp >/dev/null 2>&1 || true
echo "Deployed. URL: https://<github-user>.github.io/<repo>/"
