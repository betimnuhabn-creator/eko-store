#!/usr/bin/env bash
# A real WordPress (port 8079) with the EKO account-link snippet, for
# tests/account-link.test.mjs. LOCAL only, test data only.
#   bash tests/wp-site.sh up | down
set -euo pipefail
cd "$(dirname "$0")/.."
NET=eko-wp
CLI=(docker run --rm --network $NET --volumes-from eko-wp --user 33 -e WORDPRESS_DB_HOST=eko-wp-db -e WORDPRESS_DB_USER=wp
     -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp wordpress:cli-php8.3 wp --quiet)
if [[ "${1:-up}" == down ]]; then
  docker rm -f eko-wp eko-wp-db >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  exit 0
fi
docker rm -f eko-wp eko-wp-db >/dev/null 2>&1 || true
docker network create $NET >/dev/null 2>&1 || true
docker run -d --name eko-wp-db --network $NET -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=wp \
  -e MARIADB_USER=wp -e MARIADB_PASSWORD=wp mariadb:11.4 >/dev/null
docker run -d --name eko-wp --network $NET -p 8079:80 --add-host host.docker.internal:host-gateway \
  -e WORDPRESS_DB_HOST=eko-wp-db -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp \
  -e WORDPRESS_CONFIG_EXTRA="define('EKO_LINK_SECRET','test_link_secret_0123456789'); define('EKO_LINK_URL','http://host.docker.internal:54321/functions/v1/account-link');" \
  wordpress:6.7-php8.3-apache >/dev/null
for i in $(seq 60); do docker exec eko-wp test -f /var/www/html/wp-config.php 2>/dev/null && break; sleep 2; done
for i in $(seq 60); do "${CLI[@]}" db check >/dev/null 2>&1 && break; sleep 2; done
"${CLI[@]}" core install --url=http://localhost:8079 --title=EKO --admin_user=wpadmin --admin_password=wpadminpass \
  --admin_email=wpadmin@site.test --skip-email
"${CLI[@]}" role create customer Customer >/dev/null 2>&1 || true
"${CLI[@]}" role create wholesale_customer "Wholesale Customer" >/dev/null 2>&1 || true
"${CLI[@]}" rewrite structure '/%postname%/' --hard >/dev/null
docker exec eko-wp mkdir -p /var/www/html/wp-content/mu-plugins
( echo '<?php'; cat docs/wordpress/eko-account-link.php ) > /tmp/eko-account-link.php
docker cp /tmp/eko-account-link.php eko-wp:/var/www/html/wp-content/mu-plugins/eko-account-link.php
docker exec eko-wp chown -R www-data:www-data /var/www/html/wp-content/mu-plugins
for i in $(seq 30); do curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8079/wp-json/eko/v1/verify | grep -q 401 && break; sleep 2; done
echo "wordpress up: $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8079/wp-json/eko/v1/verify)"
