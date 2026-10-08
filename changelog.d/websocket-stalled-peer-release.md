- **A stalled Responses WebSocket peer no longer keeps its descriptor open.** The
  earlier release fix waited for queued frames to flush before releasing a dropped
  connection, so a client that stopped reading and then half-closed left one
  descriptor open for the life of the process. A transport-level end (FIN, reset,
  error) now destroys the socket outright; only a received close frame still
  flushes the close reply first.
