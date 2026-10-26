import { getErrorMessageOrDefault } from "@vortex/shared";

import { log } from "../../../logging";
import { UserCanceled } from "../../../util/CustomErrors";
import { ChallengeBlocked, DownloadThrottled, MintFailed, NotLoggedIn } from "./errors";
import { MintPacer } from "./pacing";

/** The persistent cookie jar the embedded Nexus session lives in. Survives restarts. */
export const NEXUS_WEB_PARTITION = "persist:nexus-free";

export const NEXUS_WEB_HOME = "https://www.nexusmods.com/";
const NEXUS_LOGIN_URL = "https://users.nexusmods.com/auth/sign_in";

/** How long to wait for the user to sign in / clear a challenge before giving up. */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** The minimal slice of an Electron <webview> element we drive. */
export interface IWebviewNode {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  loadURL(url: string): Promise<void> | void;
  getURL(): string;
  reload(): void;
  getAttribute(name: string): string | null;
}

export type PromptReason = "login" | "challenge";

export interface IFreeSessionUIState {
  visible: boolean;
  reason: PromptReason | null;
}

/** What the mint fetch, run inside the Nexus page, came back with. */
type FetchOutcome =
  | { kind: "ok"; url: string }
  | { kind: "login" }
  | { kind: "challenge" }
  | { kind: "throttled" }
  | { kind: "fail"; detail: string };

/** A keyed link has all three, and Vortex's resolve() checks user_id against the logged-in account. */
function isKeyedNxm(url: string): boolean {
  if (!url.startsWith("nxm://")) {
    return false;
  }
  const q = url.slice(url.indexOf("?") + 1);
  const params = new URLSearchParams(q);
  return params.has("key") && params.has("expires") && params.has("user_id");
}

/**
 * Owns the one embedded, logged-in nexusmods.com session the fork uses to mint authorised download
 * links for a free account — the same `GenerateDownloadUrl` call the website's own "slow download"
 * button makes. The link it returns is keyed, so Vortex downloads it through the normal api with no
 * premium gate, no browser hand-off and no per-mod dialog.
 *
 * A single hidden <webview> (supplied by NexusFreeSessionView) does the work: the fetch runs inside
 * the page, so cookies, Origin and Referer are the real logged-in ones. The view is only ever shown
 * to the user for the two things a headless request can't do: the one-time sign-in, and clearing a
 * Cloudflare check.
 */
class NexusWebSession {
  #webview: IWebviewNode | undefined;
  #domReady = false;
  readonly #pacer = new MintPacer();

  // set when the user dismisses a sign-in / challenge prompt, so we fall back to the stock dialog
  // for the rest of the run instead of re-prompting on every remaining mod. Cleared on a fresh
  // attach (app restart / remount).
  #userDeclined = false;

  // a tiny observable the view subscribes to, so the singleton stays the source of truth
  #uiState: IFreeSessionUIState = { visible: false, reason: null };
  readonly #listeners = new Set<() => void>();

  // resolves when the user finishes the current sign-in / challenge prompt
  #promptResolve: (() => void) | undefined;
  #promptReject: ((err: Error) => void) | undefined;

  // ---- wiring to the React view -------------------------------------------------------------

  /** Called by the view once its <webview> is in the DOM and ready. */
  attachWebview(node: IWebviewNode): void {
    this.#webview = node;
    this.#domReady = true;
    this.#userDeclined = false;
  }

  detachWebview(): void {
    this.#webview = undefined;
    this.#domReady = false;
  }

  getState(): IFreeSessionUIState {
    return this.#uiState;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The view calls this when the user says they're done with a prompt. */
  finishPrompt(): void {
    this.#promptResolve?.();
  }

  /** The view calls this when the user dismisses a prompt without finishing. */
  cancelPrompt(): void {
    this.#promptReject?.(new UserCanceled(false));
  }

  #setUI(next: IFreeSessionUIState): void {
    this.#uiState = next;
    this.#listeners.forEach((l) => l());
  }

  // ---- minting ------------------------------------------------------------------------------

  /**
   * Mint a keyed nxm link for one mod file, or throw a typed failure the caller can fall back on.
   * Serialised and paced so a run of collection members never trips Nexus's free-download cap.
   */
  mint(domain: string, numericGameId: number, modId: number, fileId: number): Promise<string> {
    return this.#pacer.run(() => this.#mintOnce(domain, numericGameId, modId, fileId));
  }

  async #mintOnce(
    domain: string,
    numericGameId: number,
    modId: number,
    fileId: number,
  ): Promise<string> {
    await this.#ensureReady();

    // the user already said no to signing in this run; don't nag, let the caller use the dialog
    if (this.#userDeclined) {
      throw new NotLoggedIn("sign-in was declined this session");
    }

    // one retry: the first attempt can legitimately come back "please sign in" or "clear this
    // check", and after the user does that the second attempt is the real one
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.#fetchDownloadUrl(domain, numericGameId, modId, fileId);
      switch (outcome.kind) {
        case "ok":
          // An nxm:// link must be keyed (so Vortex's resolve() treats it as authorised); a direct
          // https CDN link is already the signed download url and is handed straight to the fetcher.
          if (outcome.url.startsWith("nxm://") && !isKeyedNxm(outcome.url)) {
            throw new MintFailed(`minted link was not keyed: ${outcome.url}`);
          }
          return outcome.url;
        case "login":
          if (attempt === 1) {
            throw new NotLoggedIn();
          }
          await this.#promptOrDecline("login");
          break;
        case "challenge":
          if (attempt === 1) {
            throw new ChallengeBlocked();
          }
          await this.#promptOrDecline("challenge");
          break;
        case "throttled":
          // let the pacer hold everything else back, and fall back to the dialog for this one
          this.#pacer.backOff(10 * 60 * 1000);
          throw new DownloadThrottled(10 * 60 * 1000);
        case "fail":
          throw new MintFailed(outcome.detail);
      }
    }
    throw new MintFailed("exhausted mint attempts");
  }

  /** Run the GenerateDownloadUrl fetch inside the logged-in Nexus page and classify the result. */
  async #fetchDownloadUrl(
    domain: string,
    numericGameId: number,
    modId: number,
    fileId: number,
  ): Promise<FetchOutcome> {
    const webview = this.#webview;
    if (webview === undefined) {
      return { kind: "fail", detail: "no web session" };
    }

    // the fetch is same-origin to www.nexusmods.com; after a login the page can be left on
    // users.nexusmods.com, where that fetch would be cross-origin and blocked, so get home first
    await this.#ensureOnHome(webview);

    const payload = JSON.stringify({ fid: fileId, game_id: numericGameId, domain });
    // runs in the page's own context: same-origin, real cookies, real Origin/Referer
    const code = `(async () => {
      try {
        const p = ${payload};
        // skip the ad interstitial (Nexus Download Collection's bypassNexusAdsCookie)
        try {
          const exp = Math.floor(Date.now() / 1000) + 31536000;
          document.cookie = "ab=0|" + exp + "; path=/; domain=.nexusmods.com";
        } catch (e) {}
        const body = "fid=" + encodeURIComponent(p.fid)
          + "&game_id=" + encodeURIComponent(p.game_id) + "&nmm=1";
        const resp = await fetch(
          "https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body,
          },
        );
        const text = await resp.text();
        return JSON.stringify({ status: resp.status, text: text });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    })()`;

    let raw: unknown;
    try {
      raw = await webview.executeJavaScript(code);
    } catch (err) {
      return { kind: "fail", detail: `executeJavaScript failed: ${getErrorMessageOrDefault(err)}` };
    }
    return this.#classify(raw);
  }

  #classify(raw: unknown): FetchOutcome {
    let parsed: { status?: number; text?: string; error?: string };
    try {
      // the page-side code always returns a JSON string; guard anyway so a non-string can't
      // stringify to "[object Object]" and be parsed as garbage
      parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    } catch {
      return { kind: "fail", detail: "unparseable mint response" };
    }

    if (parsed.error !== undefined) {
      // a thrown fetch inside the page is usually the network being blocked (often a challenge)
      return { kind: "challenge" };
    }

    const status = parsed.status ?? 0;
    const text = parsed.text ?? "";
    const lower = text.toLowerCase();

    // a clean JSON body with a url is the success case. For a free account, GenerateDownloadUrl?nmm=1
    // answers with a direct, signed CDN link ({"url":"https://supporter-files.nexus-cdn.com/...?md5=
    // ...&expires=...&user_id=..."}), not an nxm:// link — that's the ready-to-fetch download url, so
    // accept it. (A keyed nxm:// link is still accepted for the paths that return one.)
    try {
      const obj = JSON.parse(text);
      if (typeof obj?.url === "string" && /^(nxm|https?):\/\//i.test(obj.url)) {
        return { kind: "ok", url: obj.url };
      }
      // Valid JSON, 200, but no url. When the embedded session isn't signed in, this endpoint
      // answers 200 with an empty array ([]) — not a 401 or a login page — so a urless 200 means
      // "sign in needed". Prompt once instead of falling back to the per-mod dialog.
      if (status === 200) {
        return { kind: "login" };
      }
    } catch {
      /* not JSON — fall through to the html/text classifiers below */
    }

    if (
      lower.includes("just a moment") ||
      lower.includes("cf-turnstile") ||
      lower.includes("challenge-platform") ||
      ((status === 403 || status === 503) && lower.includes("cloudflare"))
    ) {
      return { kind: "challenge" };
    }
    if (lower.includes("suspended") || lower.includes("too many") || status === 429) {
      return { kind: "throttled" };
    }
    if (
      status === 401 ||
      lower.includes("replaced-login-link") ||
      lower.includes("you must be logged in") ||
      lower.includes("sign in") ||
      lower.includes("log in")
    ) {
      return { kind: "login" };
    }
    return { kind: "fail", detail: `status ${status}: ${text.slice(0, 160)}` };
  }

  // ---- readiness & prompts ------------------------------------------------------------------

  /** Wait until the view has mounted its <webview> and it has loaded a Nexus page. */
  async #ensureReady(): Promise<void> {
    const start = Date.now();
    while (!this.#domReady || this.#webview === undefined) {
      if (Date.now() - start > 30000) {
        throw new MintFailed("embedded Nexus session never became ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Prompt the user, and remember a dismissal so we don't nag for the rest of the run. */
  async #promptOrDecline(reason: PromptReason): Promise<void> {
    try {
      await this.#prompt(reason);
    } catch (err) {
      this.#userDeclined = true;
      throw err;
    }
  }

  /** Make sure the embedded page is on www.nexusmods.com, so the mint fetch runs same-origin. */
  async #ensureOnHome(webview: IWebviewNode): Promise<void> {
    try {
      if (webview.getURL().includes("www.nexusmods.com")) {
        return;
      }
    } catch {
      /* getURL can throw before the first load; fall through and load home */
    }
    try {
      await webview.loadURL(NEXUS_WEB_HOME);
    } catch {
      /* ignore; the poll below is the real gate */
    }
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        if (webview.getURL().includes("www.nexusmods.com")) {
          return;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * Show the embedded session to the user for a sign-in or a challenge, and wait until they finish
   * (or cancel / time out). Only ever reached when a headless mint says it's needed.
   */
  async #prompt(reason: PromptReason): Promise<void> {
    if (reason === "login" && this.#webview !== undefined) {
      const url = this.#webview.getURL();
      if (!url.includes("users.nexusmods.com")) {
        void this.#webview.loadURL(NEXUS_LOGIN_URL);
      }
    }

    log("info", "free download prompting user", { reason });
    this.#setUI({ visible: true, reason });

    try {
      await new Promise<void>((resolve, reject) => {
        this.#promptResolve = resolve;
        this.#promptReject = reject;
        setTimeout(() => reject(new UserCanceled(false)), PROMPT_TIMEOUT_MS);
      });
    } finally {
      this.#promptResolve = undefined;
      this.#promptReject = undefined;
      this.#setUI({ visible: false, reason: null });
      // land back on the home page so the next mint runs same-origin to www.nexusmods.com
      if (this.#webview !== undefined && !this.#webview.getURL().includes("www.nexusmods.com")) {
        void this.#webview.loadURL(NEXUS_WEB_HOME);
      }
    }
  }
}

/** Process-wide singleton: there is exactly one embedded Nexus session. */
export const nexusWebSession = new NexusWebSession();
