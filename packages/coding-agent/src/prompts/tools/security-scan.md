OMP-native repository security scans: plan, start, inspect, cancel, validate.
`preflight`: immutable plan pinned to repository snapshot, model, exact OAuth credential.
`start`: plan → background OMP job.
`status`, `cancel`: returned operation ID.
`cloud_scans`: Codex Security cloud configurations for exact selected ChatGPT OAuth account.
`cloud_start`: creates/enables configuration using `repository_id`, `repository_url`, `environment_id`; consumes account's separate Codex Security cloud allowance; NEVER native-scan fallback.
`cloud_status`: cloud progress.
`cloud_pull`: cloud findings → canonical OMP security store, available through `security://`.
`cloud_status`/`cloud_pull`: `cloud_configuration_id` required. `cloud_scans` needs no configuration ID; `cloud_start` creates one from the repository/environment fields. All cloud actions MAY pin the account with `credential_id`.
Security MUST be enabled in settings.
