#!/usr/bin/env bash
# CI-only: point the backend at the job's throwaway PostgreSQL container and generate test-only secrets.
# Refuses to continue if an .env file is present (it could carry Neon / production credentials) or if the
# database host is anything but the local service container.
set -euo pipefail

if find "${GITHUB_WORKSPACE:?}" \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' | grep -q .; then
  echo "::error::An .env file is present in the checkout; CI must not load local or production credentials."
  exit 1
fi

url="${CI_DATABASE_URL:?CI_DATABASE_URL must be set by the workflow}"
host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$url")"
if [ "$host" != "localhost" ] && [ "$host" != "127.0.0.1" ]; then
  echo "::error::Refusing to run tests against database host '$host' — CI only uses the local service container."
  exit 1
fi

encryption_key="$(openssl rand -hex 32)"
erasure_secret="$(openssl rand -hex 32)"
echo "::add-mask::$encryption_key"
echo "::add-mask::$erasure_secret"

{
  echo "DATABASE_URL=$url"
  echo "BRAYN_ENV=development"
  echo "BRAYN_CREDENTIAL_ENCRYPTION_KEY=$encryption_key"
  echo "ERASURE_HMAC_SECRET=$erasure_secret"
} >> "${GITHUB_ENV:?}"

echo "CI test environment ready (database host: $host)."
