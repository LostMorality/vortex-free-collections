import { log } from "../../../logging";

/**
 * Serialises link mints and keeps a free account under Nexus's throttle.
 *
 * Nexus suspends a free account for ~10 minutes after roughly 200 downloads in a short window, and
 * minting a link counts as starting a download. Two battle-tested tools (Nexus Download Collection
 * and the "nextended" extension) settled on the same guard: a small gap between mints, plus a
 * pre-emptive long pause once the count approaches the cap, so the account never actually trips it.
 *
 * Everything runs through one queue because there is a single embedded web session doing the work,
 * and because the whole point is to not fire these off in parallel.
 */

/** Minimum gap between two mints. The downloads themselves are throttled by Nexus to ~3 MB/s; this
 * only keeps us from hammering the link endpoint. */
const MIN_GAP_MS = 1200;

/** Mint this many links, then take the long pause before continuing. Kept under the ~200 cap. */
const BURST_LIMIT = 180;

/** How long to pause once a burst is spent, clearing the rolling window Nexus counts against. */
const BURST_PAUSE_MS = 5 * 60 * 1000;

/** The window Nexus counts downloads over; once this elapses idle, the burst counter resets. */
const WINDOW_MS = 10 * 60 * 1000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MintPacer {
  #chain: Promise<unknown> = Promise.resolve();
  #lastMintAt = 0;
  #burstCount = 0;
  /** A hard back-off end time set when Nexus actually tells us it's throttling. */
  #throttledUntil = 0;

  /** Run `task` after honouring the inter-mint gap and the burst cap. Mints stay strictly serial. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(() => this.#gated(task));
    // keep the chain alive even if this task rejects, so one failure doesn't wedge the queue
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Nexus said it's throttling us; hold every later mint until the back-off elapses. */
  backOff(ms: number): void {
    this.#throttledUntil = Math.max(this.#throttledUntil, Date.now() + ms);
    log("warn", "free download mint backing off", { ms });
  }

  async #gated<T>(task: () => Promise<T>): Promise<T> {
    const now = Date.now();

    // a long idle gap means Nexus's rolling window has drained; start a fresh burst
    if (now - this.#lastMintAt > WINDOW_MS) {
      this.#burstCount = 0;
    }

    if (this.#throttledUntil > now) {
      await delay(this.#throttledUntil - now);
      this.#burstCount = 0;
    }

    if (this.#burstCount >= BURST_LIMIT) {
      log("info", "free download mint burst cap reached, pausing", { pauseMs: BURST_PAUSE_MS });
      await delay(BURST_PAUSE_MS);
      this.#burstCount = 0;
    }

    const sinceLast = Date.now() - this.#lastMintAt;
    if (sinceLast < MIN_GAP_MS) {
      await delay(MIN_GAP_MS - sinceLast);
    }

    this.#burstCount += 1;
    this.#lastMintAt = Date.now();
    return task();
  }
}
