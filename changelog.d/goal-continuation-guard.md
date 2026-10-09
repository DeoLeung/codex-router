- **Automatic goal continuation can stop after repeated replies without progress.**
  The optional `goalContinuationGuard` model flag refuses a continuation locally
  after three consecutive short, substantially repeated completed goal replies
  without tool activity. Fresh instructions, tool activity, and objective
  changes reset the check. It preserves history and provider options, makes no
  retry or failover, and leaves Codex's goal state to Codex. The flag defaults off.
