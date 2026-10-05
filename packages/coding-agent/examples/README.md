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
Tern window plugin that evenly splits native OMP agent and BTW panes when they open or close, without changing focus. It also resets custom split ratios in their tab.

Install once (verified with Tern 0.7.3):

```sh
tern plugin install /path/to/oh-my-pi/packages/coding-agent/examples/tern/omp-workspace
```

On WSL, give the Windows Tern CLI a Windows path, such as `\\wsl.localhost\<distribution>\home\<user>\code\oh-my-pi\packages\coding-agent\examples\tern\omp-workspace`. Existing panes are discovered on the next window start; new panes are recognized after their first native frame.

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../../../docs/extensions.md)
- [Hooks Documentation](../../../docs/hooks.md)
- [Custom Tools Documentation](../../../docs/custom-tools.md)
- [Skills Documentation](../../../docs/skills.md)
