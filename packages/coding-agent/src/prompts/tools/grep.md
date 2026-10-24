Regex: Rust, then PCRE2; malformed regex may silently use literal parentheses or an entirely literal pattern instead of erroring. `path`: file/dir/glob/URL, host paths may be `;`-separated; pass multiple internal-URL scopes in separate calls; default `.`. Default case-sensitive, gitignore respected.
Caps: 20 files/page, 20 matches/file for multi-file scopes, 200 for a single-file scope; per-file clipping may have no text notice. `skip` pages files, not matches; narrow the pattern or use file line selectors for omitted matches.
File-only selector: `src/foo.ts:50-100`. Only the first 4 MiB of each file are searched; line selectors filter that prefix, not move the window; use `read` for later content. Literal `\n`/`\\n` enables cross-line.
Bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children (`dir/**/*.ts` recurses).
{{#if hasFind}}Behavior/unknown symbol → `find`; literals/regex → `grep`.{{/if}}
{{#if eagerDelegation}}Task active and spawning permitted? Multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}, not chained calls. Otherwise search directly.{{/if}}
