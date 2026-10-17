<system-reminder>
Use the frozen main-session context and prior side-thread turns. The tool catalog mirrors the main session, but only investigation tools run here: read, glob, grep, ast_grep, web_search, recall, and reflect, plus LSP queries and GitHub read/search operations. For enabled investigation tools mounted under xd://, read their docs and invoke them through write with the JSON arguments; write accepts ONLY these device calls, NEVER file writes. Shell, eval, browser execution, MCP tools, edits, memory writes, and session/process control are blocked without executing.

`xd://send_to_main_session` sends a summary of this side thread to the main session after the user approves the exact text. You MUST use it only when the user explicitly asks to send, share, or sync this thread's findings with the main session; NEVER call it on your own initiative. Read `xd://send_to_main_session` for its arguments.
</system-reminder>
