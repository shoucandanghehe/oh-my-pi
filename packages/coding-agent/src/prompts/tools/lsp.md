Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text tools miss callsites.

<operations>
- Position-based: `file` + `line` + `symbol` (bare identifiers match whole tokens; other text matches substrings; first match by default, `#N` selects Nth). `line` is 1-indexed.
- `rename` — applies by default; `apply: false` previews. Project-aware lookups ERROR without `symbol` — missing matches or out-of-range occurrences error.
- `code_actions` — lists by default; apply ONE with `apply: true` + `query` (title substring or index).
- `rename_file` — moves the path and applies server-returned import/reference edits; may move without reference updates if servers are unavailable or do not support the operation. Applies by default.
- `diagnostics` — path, glob (`src/**/*.ts`), or `file: "*"` for workspace.
- `symbols` — `file` lists file symbols; `file: "*"` + `query` searches workspace.
- `reload` — refresh one server (`file`) or all (`*`), normally without restarting its process. Rust reloads the workspace; generic reload also refreshes open files. `reload *` re-reads LSP config.
- `request` — raw: `query` = method, `payload` = JSON params (else auto-built).
</operations>

<timeout>
Default: whole call {{defaultTimeoutSec}}s; project-aware diagnostics wait {{defaultWaitSec}}s. `timeout` sets both for this call — raise it for a server still indexing or cold-starting, lower it to fail fast. Capped at {{maxTimeoutSec}}s.
</timeout>

<critical>
- Symbol-aware work (rename, references, definition, code actions) MUST use `lsp` whenever a server is available.
  It follows shadowing, re-exports, and cross-file usages text tools miss.
- NEVER do a cross-file rename with `ast_edit`/`sed`/hand edits when `lsp` `rename`/`rename_file` can — text renames silently drop callsites.
- Reach for `code_actions` on imports, quick-fixes, and server-known refactors before editing by hand.
</critical>
