# Runtime Mental Map

Local-first runtime tracing for PHP applications. The collector and the Mental Map UI run together at **http://localhost:9000**.

## Quick Start

1. From this repository, start the collector, UI, and persistent SQLite storage:

   ```sh
   docker compose up -d
   ```

2. In your Laravel application, install the agent as a development dependency. Until the package is published, register this local checkout once with Composer:

   ```sh
   composer config repositories.mental-map '{"type":"path","url":"/absolute/path/to/runtime-mental-map/agent-php","options":{"symlink":true}}'
   composer require --dev runtime-mental-map/agent-php:dev-main
   php artisan mental-map:install
   php artisan mental-map:doctor
   ```

   The package discovers its Laravel provider and installs HTTP middleware automatically. `mental-map:install` creates `config/runtime-map.php` once and preserves it on repeat runs. If the app itself runs in Docker on macOS, set `MENTAL_MAP_COLLECTOR=http://host.docker.internal:9000` in its `.env`; a host-run app can use the default `http://127.0.0.1:9000`.

3. Use the application, then open **http://localhost:9000**. Each HTTP response includes an `X-Runtime-Trace-Id` header for finding its trace.

Automatic method and SQL tracing requires **ext-opentelemetry** in the PHP runtime that runs your application. For a local PHP installation, install it with `pecl install opentelemetry` and enable `extension=opentelemetry.so` in the active PHP configuration. For a Dockerized PHP app, add those steps to its PHP image. Without the extension, request spans still work; `mental-map:doctor` identifies the missing instrumentation.

### Slim

Install the same dev package, then run:

```sh
vendor/bin/mental-map init
vendor/bin/mental-map doctor
```

`init` detects Slim, creates `config/mental-map.php`, and prints the one middleware line to add to your app setup. It preserves existing configuration. Add that line before running the app, then use a route and open the UI.

## Configuration

The Laravel config file is `config/runtime-map.php`; Slim uses `config/mental-map.php`. Both support these environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MENTAL_MAP_ENABLED` | Turn tracing on or off | Laravel: on only in `local`; Slim: on |
| `MENTAL_MAP_COLLECTOR` | Collector base URL | `http://127.0.0.1:9000` |
| `MENTAL_MAP_SERVICE_NAME` | Name shown in the UI | Laravel `APP_NAME`; Slim project folder |
| `MENTAL_MAP_DEBUG` | Log a transport warning during diagnosis | off |

Laravel still accepts the earlier `RUNTIME_MAP_ENABLED`, `RUNTIME_MAP_COLLECTOR_URL`, and `RUNTIME_MAP_SERVICE_NAME` names. Directory-to-layer mappings and namespace exclusions live in the PHP config. Missing candidate directories are skipped. SQL service-query visibility is a UI display filter; raw SQL spans remain in the trace.

`mental-map:doctor` checks the PHP runtime, package, extension, middleware (Laravel), source mappings, collector health, and protocol version. A failed doctor check does not prevent the application from serving requests. If the collector is down, the agent drops that batch after a short timeout and retries later. A missing collector does not interrupt the app.

The collector's `GET /health` returns its supported protocol version. Saved Mental Maps live in the Docker volume `mental-map-data`, which survives container recreation. Incoming raw traces currently live in collector memory and restart with the collector.

## Development

The usual development workflow remains available: run `go run .` from `collector/` and `npm run dev` from `web/` for Vite hot reload. The Vite server proxies `/api` to the collector. The Docker build bundles the production React app with the Go collector; direct endpoints such as `/events/batch` remain compatible with existing agents.

The PHP package is currently installed from a local Composer path repository. Direct `composer require --dev runtime-mental-map/agent-php` without that repository setting requires publishing a versioned package. The agent is intended for local development, not production APM.
