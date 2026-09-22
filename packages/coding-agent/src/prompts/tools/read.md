Use `read` for static web; browser only if needed.

## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)

- `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:-60` — last 60 lines | `:5-16,960-973` / `:19,59` — multiple ranges or individual lines
- `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim
- `:conflicts` — one line per unresolved git merge conflict block
- `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters
- Bare image path → pixels sent directly to the active model. When it supports image input, MUST use this for image understanding, except for the `?q=` cases below; also works with `attachment://N` and `.svg:img`.
- `?q=<question>` — image only (also `.svg:img?q=`, `attachment://N?q=`, `local://…?q=`): a separate vision-model call returns text, not pixels. Use only when the active model cannot accept images, direct image delivery failed, or the user requests a separate visual opinion. NEVER substitute it merely to save context or override a request to inspect the image directly.
- Videos (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`, `.avi`, `.wmv`) need system `ffmpeg`/`ffprobe`: bare read returns a preview grid plus metadata (resolution, codecs, duration, fps); `:412` extracts frame 412, `:1h5m42s`/`:90s`/`:01:23` seeks to a timestamp

## Source kinds

- Parseable code, no selector → structural summary (declarations only, body elided). Footer names recovery selector — re-issue ONLY those ranges.
{{#if IS_HL_MODE}}- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.
{{/if}}
- Directory → depth-limited dirent listing. Root is complete; page long listings with `:N-M`/`:-N`. Child dirs cap at 12 entries (`… N more` marker) — read the sub-path to expand.
- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.
- Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`/`.a`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.
{{#if BINARY_VIEWS}}- Executables (ELF/PE/Mach-O, extensionless ok): overview + function list; `:<func|0xaddr>` pseudocode, `:<func>:asm`, `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>`; line ranges apply after the view (`bin:main:10-40`). Universal Mach-O: host-arch slice by default, `bin:@<arch>` picks another (`bin:@x86_64:main`).
{{/if}}
- Documents → extracted text. Notebooks → editable cells. Images → decoded inline for vision-capable models; use bare paths by default. `img.png?q=<question>` returns a separate model's description under the conditions above; it does not let the active model see the image. Videos → preview grid plus metadata. SVGs read as text unless `:img` is specified; `:raw` bypasses converters.
- URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.
- Internal URIs — `artifact://<id>` recovers spilled output; page with `:N-M`/`:raw:N-M`.
- `ssh://host/<path>` reads remote file/dir (UTF-8, ≤1 MiB); bare `ssh://` lists hosts; writable with `write` and searchable with `grep`.
  Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). Requires a verified POSIX shell on the remote host. For Windows or other unsupported hosts, use `bash` with a remote SSH command or mount with `sshfs`.

<critical>
Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
