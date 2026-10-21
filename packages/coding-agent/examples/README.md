# Examples

Example code for omp-coding-agent SDK, extensions, hooks, and custom tools.

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, hooks, and session management.

### [extensions/](extensions/)
Example extensions using `ExtensionAPI`: custom tools, commands, UI, and system prompt changes.

### [hooks/](hooks/)
Example hooks (`HookAPI` factories) for intercepting tool calls, adding safety gates, and integrating with external systems. They load through the extension runner.

### [custom-tools/](custom-tools/)
Example custom tools that extend the agent's capabilities.

### [tern/omp-workspace/](tern/omp-workspace/)
Tern window plugin that evenly splits native OMP agent and BTW panes when they open or close, without changing focus. OMP sends lifecycle notifications through `tern ctl open-url`; the plugin balances the active tab immediately and defers background tabs until they are selected. It uses focus events, not polling or transcript inspection, and resets custom split ratios only in tabs with a pending notification.

Install (verified with Tern 0.9.5):

```sh
tern plugin install /path/to/oh-my-pi/packages/coding-agent/examples/tern/omp-workspace --force
```

On WSL, give the Windows Tern CLI a Windows path, such as `\\wsl.localhost\<distribution>\home\<user>\code\oh-my-pi\packages\coding-agent\examples\tern\omp-workspace`. Upgrade existing installations to plugin 0.2.1 or later for balancing in long-running Tern sessions with large pane IDs; no OMP update is needed if it already sends lifecycle notifications. Without a compatible enabled plugin, native panes still work but do not automatically rebalance.

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../../../docs/extensions.md)
- [Hooks Documentation](../../../docs/hooks.md)
- [Custom Tools Documentation](../../../docs/custom-tools.md)
- [Skills Documentation](../../../docs/skills.md)
