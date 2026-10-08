# Final label rules (fresh-100 reconciliation)

Rule set `R1`, set by the Opus coordinator on 2026-10-08 for `P1-RECONCILE-01..05`.
Clarified after `P1-RECONCILE-01` (R1 failing Dockerfile, R4 storage, R6 extra services);
the batch 1 and 2 final labels already follow the clarified text.
All five reconcile tasks apply the same rules. Sources: `docs/product/mvp-scope.md`
(authoritative support boundary), `docs/testing/compatibility.md` (gate meaning) and
`expectedFactsSchema` in `scripts/repository-compatibility/manifest.ts`.

The source files at the pinned commit decide every disagreement. Never use Deployz output.

## R1. Compatibility

The gate outcome that a freshly imported app with no configured values gets, for the
default production path (default Dockerfile or production stage, default configuration).

- `NOT_COMPATIBLE` when the default path needs an MVP non-goal and no supported
  configuration removes it:
  - only an unsupported database: MongoDB, SQLite, MariaDB-only, SQL Server,
    ClickHouse, Elasticsearch/OpenSearch, BoltDB, H2 or another embedded database;
  - Kafka or RabbitMQ is required;
  - extra long-running application services beyond the web service and declared workers;
  - persistent volume or local disk state: a data directory, local uploads with no S3
    option, or a configuration file that the image expects to be mounted;
  - Docker socket, Docker Swarm, Kubernetes, GPU, Windows or privileged containers;
  - no Dockerfile that builds a production image (see R2), including a Dockerfile that
    fails on the pinned source (for example a missing lockfile or a missing
    `output: standalone`);
  - the Dockerfile copies artifacts that the repository does not contain and the
    Dockerfile does not build (for example a prebuilt `target/`, `out/` or binary).
- `NEEDS_CONFIGURATION` when the app is inside the boundary but the vendor must set a
  value before it can deploy: a required environment value with no default that Deployz
  does not provision (secret, external URL, admin account), a switch from an unsupported
  default store to a supported one by environment (for example SQLite default with a
  PostgreSQL option, when no other local state stays required), a start command or
  argument that the image does not set, or a build context or Dockerfile that is not the
  default for the app root.
- `READY` when the app deploys with no configured values.

## R2. Missing Dockerfile

No production Dockerfile at the pinned commit = `NOT_COMPATIBLE` (mvp-scope.md: compute
"Needs a Dockerfile"). A development-only Dockerfile or a CI image does not count. Omit
`dockerfilePath`.

## R3. Databases

- `postgres: true` when the app supports PostgreSQL as its production database, as the
  default or by configuration. `false` when PostgreSQL is not supported.
- MySQL 8.0 is supported (RDS MySQL). A MySQL default is never a blocker by itself and
  gets no `unsupported` entry.

## R4. Optional services

`redis`, `worker` and `storage` are `true` only when the default production configuration,
or the configuration that the verdict depends on, requires them. Optional ones are `false`
(record "optional" in `notes`). `worker: true` needs a declared separate worker process.
`storage: true` only when S3-compatible object storage is required, also when the verdict
depends on an S3 option that removes default local uploads; omit it otherwise.

## R5. Migration

`migration: true` when the source has a migration tool or a named migration command or
script (Alembic, `rails db:migrate`, Prisma migrate, Ecto, EF, Flyway, a `migrate` script),
also when it runs at startup. Omit it when no migration exists or only opaque in-app
migrations exist.

## R6. Unsupported families

Set `unsupported` only on `NOT_COMPATIBLE` apps, for each non-goal family that the verdict
depends on. Omit it otherwise (also for missing-Dockerfile and prebuilt-artifact causes).

| Cause | Family |
|---|---|
| SQLite, data directory, local uploads, mounted config file | `local-filesystem` |
| MongoDB | `mongodb` |
| Elasticsearch, OpenSearch | `elasticsearch` |
| ClickHouse, SQL Server, H2, BoltDB, Cassandra, other embedded databases | `other-database` |
| MariaDB-only (MySQL 8.0 not supported) | `mysql` |
| Required separate process or extra long-running application service that the MVP cannot run | `background-worker` |
| Kafka, RabbitMQ, Kubernetes, others | the lowercase product name (`kafka`, `rabbitmq`, `kubernetes`, `docker`) |

## R7. Runtime

Use `node`, `python`, `ruby`, `go`, `java` (all JVM languages, not `jvm`), `php`,
`dotnet`, `elixir`, `rust`, `deno`. Use the runtime that the production image runs.

## R8. Paths, port and health

`appRoot` and `dockerfilePath` are relative to the repository root. `appRoot` is the corpus
`appPath` unless the source shows otherwise. `port` and `healthPath` come from source
(EXPOSE, CMD, configuration default, HEALTHCHECK, routes). Omit them when not found; do not
guess.

## R9. Invalid entries

When the pinned commit or the app path does not exist, or the entry is not a deployable
application, set `finalStatus: REPO_INVALID` with `invalidEvidence`. Never drop an entry.
Other entries get `finalStatus: LABELED`.
