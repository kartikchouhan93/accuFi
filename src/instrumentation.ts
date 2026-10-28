// Next calls register() once when the server starts. The recurring sweep is started here because the container runs a
// single long-lived process (`bun --bun run start`), so an in-process timer needs no cron and no second service.
export async function register(): Promise<void> {
  // The edge runtime has no timers worth keeping and cannot load the database client, so only Node (which is also what
  // Bun reports) starts the sweep.
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { startSweepTimer } = await import("@/server/sweep-timer")
  const { sweepAll } = await import("@/server/services/recurring-generation")
  startSweepTimer({ run: sweepAll })
}
