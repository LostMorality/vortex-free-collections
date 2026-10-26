/**
 * Typed failures the free-download mint can hit. `resolve()` falls back to the stock website
 * dialog for any of these, so they carry enough detail to log why without being fatal.
 */

/** The embedded Nexus session isn't signed in (or is signed into a different account). */
export class NotLoggedIn extends Error {
  constructor(message = "Not logged in to the embedded Nexus session") {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Cloudflare (or a similar challenge) is in the way and needs a human to clear it. */
export class ChallengeBlocked extends Error {
  constructor(message = "A browser check is blocking the download link") {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Nexus is rate-limiting / temporarily suspending the account for too many downloads. */
export class DownloadThrottled extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "Nexus is temporarily throttling downloads") {
    super(message);
    this.name = this.constructor.name;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The response didn't contain a usable download link (a signed CDN url or a fully-keyed nxm link). */
export class MintFailed extends Error {
  constructor(message = "Could not mint a download link") {
    super(message);
    this.name = this.constructor.name;
  }
}
