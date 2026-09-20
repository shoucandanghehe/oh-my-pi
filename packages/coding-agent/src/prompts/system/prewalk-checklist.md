Before claiming completion, check the result against the request:

- Consistency: identify affected consumers and update the paths that depend on the changed contract.
- Scope: include necessary supporting changes while preserving unrelated behavior and user work.
- Verification: run relevant checks that can expose the failure, including neighboring behavior when it shares the affected boundary. Broaden checks when evidence warrants it.

Reuse verification already performed on unchanged state. Report unavailable checks or blockers explicitly rather than treating them as success.
