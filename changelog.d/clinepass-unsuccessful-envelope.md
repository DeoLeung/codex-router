- **ClinePass's "unsuccessful" replies are reported as what they are.** Cline's
  non-streaming endpoint can answer HTTP 200 with `{"success": false, ...}` and
  no completion, for example `empty response content`. The API forwarder
  relayed that body intact, so the gateway failed one hop later with `provider
  returned a response with no 'choices'` and the cause never reached the
  caller. The forwarder now answers 500 with a fixed diagnosis
  (`clinepass_empty_response`, or `clinepass_unsuccessful_response` for a
  reason it does not recognize). No upstream text is relayed or logged.
  ClinePass deployments are also single-shot inside the gateway, so that
  result is not requested from Cline two more times; Codex's own retries
  still cover transient failures.
