- **A refused Responses stream now says why in the service log.** When the
  API forwarder voids an upstream Responses stream (a changed response id, data
  after the terminal event, a stream that ends early), the reason reached the
  client only inside an SSE frame that the gateway relays as "Response API
  in-stream error", so no log named the cause. The forwarder now writes one
  `refused Responses stream provider=... model=...: <reason>` line per refused
  stream. The text is router-authored; no upstream bytes are logged.
