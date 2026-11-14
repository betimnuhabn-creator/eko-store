#!/usr/bin/env bash
# Builds the admin panel and publishes it to the `gh-pages` branch of this
# repository (GitHub Pages: Settings → Pages → Deploy from a branch → gh-pages / root).
# Uses only the public values in .env.production. Refuses to run with a secret key.
set -euo pipefail
cd "$(dirname "$0")"
grep -vE '^[[:space:]]*#' .env.production | grep -qE 'sb_secret_|service_role' && { echo "Secret key in .env.production — aborting"; exit 1; }
npm run build
# Public legal pages must carry a real contact e-mail (VITE_CONTACT_EMAIL in .env.production).
if grep -l 'KONTAKTI-MUNGON' dist/*.html >/dev/null 2>&1; then
  if [[ "${EKO_SKIP_LEGAL:-}" == 1 ]]; then
    # Publish the panel only; the legal pages wait until the contact e-mail is set.
    rm -f dist/privacy.html dist/terms.html dist/delete-account.html dist/assets/legal-*.css
    echo "Legal pages left out (EKO_SKIP_LEGAL=1, VITE_CONTACT_EMAIL not set)"
  else
    echo "VITE_CONTACT_EMAIL is missing in .env.production: legal pages would have no contact — aborting"
    echo "(EKO_SKIP_LEGAL=1 publishes the panel without the legal pages)"; exit 1
  fi
fi
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
