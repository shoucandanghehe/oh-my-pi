Wait only when blocked with nothing else to do.
Queued messages or undelivered results return immediately. Otherwise blocks on background jobs/services you started; returns on the first result, a message sent to you, or a steering interrupt; a safety cap returns a still-running snapshot.
No queued message/result or running work you started? Errors; NEVER wait on other agents.
Results and messages auto-deliver. NEVER poll while work remains.
