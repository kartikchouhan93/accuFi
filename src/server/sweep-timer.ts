// The in-process timer behind the recurring-entries sweep (design §6, "When it runs"). It lives apart from
// instrumentation.ts so it can be tested with fake timers and without importing anything that touches the database.

const DEFAULT_INTERVAL_MS = 3_600_000
const MAX_INTERVAL_MS = 2_147_483_647

export type SweepTimerOptions = {
  run: () => Promise<void>
  intervalMs?: number
  env?: Record<string, string | undefined>
  log?: Pick<Console, "error">
}

// Only a plain run of digits that is above zero and fits setInterval counts. Number("") is 0 and Number("1.5") is not
// an integer, so a blank or fractional variable falls back to the default instead of producing a timer that spins or
// never fires. setInterval stores its delay in a signed 32-bit integer and clamps anything larger to 1 ms, so a
// "monthly" 2592000000 would make the sweep spin; such a value is ignored too.
function intervalFromEnv(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return n > 0 && n <= MAX_INTERVAL_MS ? n : null
}

/**
 * Runs `run` once now and then every interval. Returns null when RECURRING_SWEEP is "off" (the e2e server sets it, so
 * a background sweep cannot race a test's own fixtures). A tick that finds the previous run still going is skipped,
 * so a slow sweep is never started twice at once. A failure is logged and never thrown: it must not take the server
 * down, and the next tick is another attempt. The timer is unref'd so it never keeps a process alive on its own.
 */
export function startSweepTimer(options: SweepTimerOptions): { stop(): void } | null {
  const env = options.env ?? process.env
  if (env.RECURRING_SWEEP === "off") return null

  const intervalMs = intervalFromEnv(env.RECURRING_SWEEP_INTERVAL_MS) ?? options.intervalMs ?? DEFAULT_INTERVAL_MS
  const log = options.log ?? console
  let running = false

  const tick = (): void => {
    if (running) return
    running = true
    // run is called synchronously (the first sweep starts at once), so a synchronous throw is caught here rather than
    // by the promise chain; either way the flag is cleared and the next tick tries again.
    let pending: Promise<void>
    try {
      pending = options.run()
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending
      .catch((error: unknown) => {
        log.error("[recurring-sweep] run failed:", error)
      })
      .finally(() => {
        running = false
      })
  }

  tick()
  const handle = setInterval(tick, intervalMs)
  handle.unref()
  return { stop: () => clearInterval(handle) }
}
