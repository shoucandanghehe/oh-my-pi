#!/usr/bin/env bash

/usr/bin/logger --tag omp-ci-admission -- \
    "event=${GITHUB_EVENT_NAME:-} repository=${GITHUB_REPOSITORY:-} ref=${GITHUB_REF:-} workflow=${GITHUB_WORKFLOW_REF:-} worker=$PPID" || true

if [[ "${GITHUB_REPOSITORY:-}" == shoucandanghehe/oh-my-pi &&
      "${GITHUB_REF:-}" == refs/heads/main &&
      "${GITHUB_WORKFLOW_REF:-}" == shoucandanghehe/oh-my-pi/.github/workflows/app-viewport-backend-preview.yml@refs/heads/main &&
      ( "${GITHUB_EVENT_NAME:-}" == push || "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ) ]]; then
    exit 0
fi

# A failed hook alone still permits workflow steps with if: always().
# Stop this job's Worker, not the Listener, before any workflow code runs.
kill -KILL "$PPID"
exit 1
