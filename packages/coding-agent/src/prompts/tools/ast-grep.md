Structural code search via ast-grep. Use when syntax shape matters more than text (calls, declarations, language constructs).

<instruction>
- Narrow each call to one language. `pat` is ONE AST pattern; separate calls for unrelated patterns.
- Set `lang` when extension inference is ambiguous (for example, `cpp` for `.h`); `.cu` and `.cuh` infer as C++.
- `$NAME` captures one node; `$_` matches without binding; `$$$NAME` zero-or-more; `$$$` zero-or-more unbound.
  - Use `$$$NAME`, NOT `$$NAME` (invalid). Names UPPERCASE, whole node — `prefix$VAR` fails.
- Same metavariable twice → MUST match identical code (`$A == $A` matches `x == x`, not `x == y`).
- Patterns MUST parse as single AST node. Non-standalone → wrap: `class $_ { … }`.
- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`.
- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- Declaration forms are distinct — `function foo`, method `foo()`, `const foo = () => {}`; search the right form before concluding absence.
- Loosest existence check: `pat: "executeBash"` with narrow `path`.
</instruction>

<critical>
- AVOID repo-root scans — narrow `path` first.
- Parse issues may identify pattern, language, or source syntax errors; matches may still be returned. Inspect diagnostics before changing the pattern or concluding absence.
{{#if eagerDelegation}}- Broad cross-subsystem exploration → {{#if scoutAvailable}}Task tool + scout{{else}}Task tool{{/if}} subagent first.{{/if}}
</critical>
