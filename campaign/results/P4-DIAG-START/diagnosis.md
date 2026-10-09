# P4-DIAG-START: diagnosis of family F10 (start/health failures)

Method: read-only. Sources: redacted stage evidence `campaign/results/first-run/build/repo-<id>.local.json`, raw logs `campaign/logs/P3-BUILD-*/evidence/repo-<id>-run.log`, `campaign/corpus/deploy-config.yaml`, and the pinned source snapshot in `docs/testing/repository-compatibility/.cache/` (API snapshot cache; some files are not cached). No Docker, no Deployz analysis run.

## Summary

| App | Family | Confidence |
| --- | --- | --- |
| repo-573 (mem0ai/mem0) | F8 harness run env (missing minted key `JWT_SECRET`) | proven |
| repo-514 (hexpm/hexpm) | new family F11: Dockerfile with no default start command (gate accepts) | proven from source and evidence |
| repo-523 (Freika/dawarich) | new family F11: same | proven |
| repo-502 (getredash/redash) | UNDIAGNOSED | cause line not captured |

## repo-573: F8 (harness run environment)

- Proof, app log (`probes.evidence.appLogTail`, last lines):
  `File "/app/main.py", line 91, in <module>  raise RuntimeError(  RuntimeError: JWT_SECRET is required. Set it in .env (generate with openssl rand -base64 48) or set AUTH_DISABLED=true for local development only.`
- Source `server/main.py` (cache, mem0ai/mem0@b7ad69a): `if not AUTH_DISABLED and not JWT_SECRET: raise RuntimeError("JWT_SECRET is required. ...")`.
- The gate manifest lists `"generatedKeys": ["JWT_SECRET"]`, but the run stage `environmentNames` is `DATABASE_URL, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER, PORT`. `JWT_SECRET` was not set, so the uvicorn child crashed on import. The Dockerfile `CMD` uses `--reload`, so the parent process stayed alive: `start` PASSED ("still running 60 s") while `health` got no answer (last status none).
- Missing env var: `JWT_SECRET` (a Deployz-generated key). `scripts/repository-deployment/local-run.ts` line 243 now mints every manifest `generatedKeys` entry (`for (const key of manifest.generatedKeys) if (!env.has(key)) env.set(key, generateKey());`). The F8 fix on the branch covers this. A rerun should clear it.
- Health path note: deploy-config sets `healthPath: "/auth/setup-status"` (repo-573 override); the manifest said `/v1/ping`. The run used the override. This did not cause the failure, because the app never started. The dbWrite FAIL follows from the app not starting.

## repo-514 and repo-523: new family F11 "Dockerfile without a default start command"

Name: F11 Dockerfile image has no default start command (no `CMD`, or `ENTRYPOINT` without `CMD`); the real start command exists only in a compose file. The gate accepts (`NEEDS_CONFIGURATION`, "correct-accept"). The built image cannot start the app by itself.

### repo-514 (hexpm/hexpm)
- Evidence: `health`: "the container exited (code 0) before / answered"; `start`: "the container is not running (exit code 0)"; `appLogTail` is empty (the raw log has no app output).
- Source `Dockerfile` (hexpm@151266f), final stage `FROM debian:${DEBIAN_VERSION} AS app`: only `COPY --from=build /app/_build/prod/rel/hexpm ./`, `USER nobody`, `ENV HOME/LANG/GIT_*`, `ARG GIT_SHA/GIT_AUTHOR`. No `CMD` and no `ENTRYPOINT` in the file. The `debian` default command is `bash`, which exits 0 with no TTY. The build log tail shows the release is built (`_build/prod/rel/hexpm/bin/hexpm start` under "To start your system").
- Cause: exit code 0 and empty log match the base image default `bash`, not an app crash. That the app runs with `/app/bin/hexpm start` was not tested (no Docker run allowed in this task).

### repo-523 (Freika/dawarich)
- Evidence: `health`: "the container exited (code 128) before /api/v1/health answered"; `appLogTail`: `bundler: exec needs a command to run`.
- Source `docker/Dockerfile` (dawarich@e32b707): `ENTRYPOINT [ "bundle", "exec" ]` and no `CMD`. `docker/docker-compose.yml` supplies the start: `entrypoint: web-entrypoint.sh` and `command: ['bin/rails', 'server', '-p', '3000', '-b', '::']`.
- Cause: `bundle exec` runs with no command.

### Systemic assessment (for Opus)
Both images need a start command that only the compose file gives. A task definition that uses the image `CMD`/`ENTRYPOINT` as is would fail the same way on AWS (the container exits at start). This looks like a systemic MVP gap close to F1 (an unrunnable Dockerfile accepted by the gate). Direction for Opus to decide: analysis reports "Dockerfile defines no start command" (no `CMD`, or `ENTRYPOINT` without `CMD`) as a not-compatible or needs-input finding, with a test next to the F1 tests. I did not run analysis; a grep of `packages/analysis/src/manifest.ts` for `CMD`/`ENTRYPOINT` found no such check.

## repo-502: UNDIAGNOSED

- Evidence: `health`: "the container exited (code 1) before /ping answered"; `start` FAIL (exit 1). `appLogTail` and the raw log `campaign/logs/P3-BUILD-02/evidence/repo-502-run.log` hold only the last 40 lines (`LOG_TAIL_LINES = 40` in `local-run.ts`). All are gunicorn arbiter frames, ending in `gunicorn.errors.HaltServer: <HaltServer 'Worker failed to boot.' 3>`. The exception that made the worker fail to boot is in no artifact.
- Run env: `DATABASE_URL, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER, PORT, REDIS_URL`; gate `generatedKeys` is empty. Redash `compose.yaml` says "Set secret keys in the .env file" and sets `REDASH_*` variables, so a missing secret or `REDASH_*` setting is a possible cause. It is not proven: `redash/settings/__init__.py` and `bin/docker-entrypoint` are not in the cache. Not classified as F8.
- Missing to decide: the first traceback lines of the worker boot error (full container log), or the Redash settings source at e170795.
- Next step: rerun repo-502 with the F8 harness and a larger app log tail, or read `redash/settings/__init__.py` at e170795.
- Side note: the 40-line tail hid the cause. Keeping the first error line, or a longer tail, is a small harness change for Opus to consider. This task does not queue it.
