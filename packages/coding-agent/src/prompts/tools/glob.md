Glob files/dirs: host paths (`;`-separated) or one internal-URL scope (`local://*.md`, `omp://**/*.md`); pass multiple internal-URL scopes in separate calls; default workspace root.
`gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Traversal always excludes `.git` entries regardless of these flags; an exact existing file path bypasses traversal. Newest-first by directory; dirs end `/`.
{{#ifAny eagerDelegation hasFind}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if eagerDelegation}}Task active and spawning permitted? Multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}. Otherwise discover directly.{{/if}}
{{/ifAny}}
