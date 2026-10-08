# Campaign results

Redacted evidence only. One directory per task: `<task id>/result.json` plus per-repo `<repo id>.json`.

- `first-run/`, `remediated/`, `final/` and `holdout/` hold separate result sets. Do not merge them.
- `holdout/` is written only in Phase 6.
- Raw logs go to `campaign/logs/`, caches to `campaign/.cache/`. Both are ignored by git.
- No tokens, passwords, emails, AWS keys or `.env` values.
