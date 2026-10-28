import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startSweepTimer } from "@/server/sweep-timer"

const HOUR = 3_600_000

describe("startSweepTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs once immediately and again after one interval", async () => {
    const run = vi.fn(async () => {})
    const timer = startSweepTimer({ run, env: {} })
    expect(timer).not.toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    timer?.stop()
  })

  it("returns null and never runs when RECURRING_SWEEP is off", async () => {
    const run = vi.fn(async () => {})
    expect(startSweepTimer({ run, env: { RECURRING_SWEEP: "off" } })).toBeNull()
    await vi.advanceTimersByTimeAsync(HOUR * 3)
    expect(run).not.toHaveBeenCalled()
  })

  it("skips a tick while the previous run is still going", async () => {
    const run = vi.fn(() => new Promise<void>(() => {}))
    const timer = startSweepTimer({ run, env: {} })
    await vi.advanceTimersByTimeAsync(HOUR * 3)
    expect(run).toHaveBeenCalledTimes(1)
    timer?.stop()
  })

  it("logs a rejection once and still runs on the next tick", async () => {
    const log = { error: vi.fn() }
    const run = vi.fn(async () => {
      throw new Error("boom")
    })
    const timer = startSweepTimer({ run, env: {}, log })
    await vi.advanceTimersByTimeAsync(0)
    expect(log.error).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(run).toHaveBeenCalledTimes(2)
    expect(log.error).toHaveBeenCalledTimes(2)
    timer?.stop()
  })

  it("does not throw when run throws synchronously", async () => {
    const log = { error: vi.fn() }
    const run = vi.fn((): Promise<void> => {
      throw new Error("sync boom")
    })
    const timer = startSweepTimer({ run, env: {}, log })
    await vi.advanceTimersByTimeAsync(0)
    expect(log.error).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(run).toHaveBeenCalledTimes(2)
    timer?.stop()
  })

  it("honours RECURRING_SWEEP_INTERVAL_MS and ignores anything that is not a positive integer", async () => {
    const fast = vi.fn(async () => {})
    const a = startSweepTimer({ run: fast, env: { RECURRING_SWEEP_INTERVAL_MS: "2000" } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(fast).toHaveBeenCalledTimes(2)
    a?.stop()

    for (const bad of ["abc", "0", "-5", "1.5", "", "2147483648", "2592000000"]) {
      const run = vi.fn(async () => {})
      const b = startSweepTimer({ run, env: { RECURRING_SWEEP_INTERVAL_MS: bad } })
      await vi.advanceTimersByTimeAsync(HOUR - 1)
      expect(run, `value ${JSON.stringify(bad)}`).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(run, `value ${JSON.stringify(bad)}`).toHaveBeenCalledTimes(2)
      b?.stop()
    }
  })

  it("accepts the largest delay setInterval can hold", async () => {
    const run = vi.fn(async () => {})
    const timer = startSweepTimer({ run, env: { RECURRING_SWEEP_INTERVAL_MS: "2147483647" } })
    await vi.advanceTimersByTimeAsync(HOUR * 3)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(run).toHaveBeenCalledTimes(2)
    timer?.stop()
  })

  it("treats an empty RECURRING_SWEEP as not off (docker-compose passes an empty string when unset)", async () => {
    const run = vi.fn(async () => {})
    const timer = startSweepTimer({ run, env: { RECURRING_SWEEP: "", RECURRING_SWEEP_INTERVAL_MS: "" } })
    expect(timer).not.toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(run).toHaveBeenCalledTimes(2)
    timer?.stop()
  })

  it("stops ticking after stop()", async () => {
    const run = vi.fn(async () => {})
    const timer = startSweepTimer({ run, env: {} })
    timer?.stop()
    await vi.advanceTimersByTimeAsync(HOUR * 3)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
