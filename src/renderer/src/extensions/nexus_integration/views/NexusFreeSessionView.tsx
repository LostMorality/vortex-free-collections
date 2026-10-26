import * as React from "react";
import { Button } from "react-bootstrap";

import { log } from "../../../logging";
import type { IFreeSessionUIState, IWebviewNode } from "../freeDownload/nexusWebSession";
import {
  NEXUS_WEB_HOME,
  NEXUS_WEB_PARTITION,
  nexusWebSession,
} from "../freeDownload/nexusWebSession";

const PROMPT_COPY: Record<"login" | "challenge", { title: string; body: string }> = {
  login: {
    title: "Sign in to Nexus Mods",
    body:
      "Sign in to your Nexus Mods account to turn on automatic, hands-off collection downloads. " +
      "Use the same account you're logged into in Vortex. You only have to do this once.",
  },
  challenge: {
    title: "Quick browser check",
    body:
      "Nexus Mods needs you to complete a short browser check. Once it clears, your collection " +
      "keeps downloading automatically — no need to do anything else.",
  },
};

/**
 * Hosts the single hidden Nexus web session (see freeDownload/nexusWebSession) and shows it to the
 * user only when a sign-in or a browser check is needed. The <webview> stays mounted the whole time
 * so its logged-in session persists; we only toggle its size/position, never reparent it (that would
 * reload it and drop the session).
 */
/** Dialog props Vortex's DialogContainer passes every registered dialog; we don't use them. */
interface INexusFreeSessionProps {
  visible?: boolean;
  onHide?: () => void;
}

class NexusFreeSessionView extends React.Component<INexusFreeSessionProps, IFreeSessionUIState> {
  #node: (HTMLElement & IWebviewNode) | null = null;
  #unsubscribe: (() => void) | undefined;

  constructor(props: INexusFreeSessionProps) {
    super(props);
    this.state = nexusWebSession.getState();
  }

  public componentDidMount(): void {
    this.#unsubscribe = nexusWebSession.subscribe(() => {
      this.setState(nexusWebSession.getState());
    });
  }

  public componentWillUnmount(): void {
    this.#unsubscribe?.();
    nexusWebSession.detachWebview();
  }

  public render(): React.ReactNode {
    const { visible, reason } = this.state;
    const copy = reason !== null ? PROMPT_COPY[reason] : undefined;

    return (
      <div className="nexus-free-session-root">
        {visible && (
          <div style={backdropStyle} onClick={undefined}>
            {copy !== undefined && (
              <div style={headerStyle}>
                <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{copy.title}</div>
                <div style={{ opacity: 0.85 }}>{copy.body}</div>
              </div>
            )}
            <div style={footerStyle}>
              <Button onClick={this.#onCancel} style={{ marginRight: 8 }}>
                Cancel
              </Button>
              <Button bsStyle="primary" onClick={this.#onDone}>
                I&apos;m done
              </Button>
            </div>
          </div>
        )}
        {this.#renderWebview(visible)}
      </div>
    );
  }

  #renderWebview(visible: boolean): React.ReactNode {
    // same element in both states — only the style changes, so the session is never torn down
    // No useragent override on purpose: overriding the UA string leaves navigator.userAgentData
    // (client hints) reporting the real engine, and Cloudflare Turnstile fails the login on that
    // mismatch. The native, self-consistent UA passes the check.
    return React.createElement("webview", {
      ref: this.#attach,
      src: NEXUS_WEB_HOME,
      partition: NEXUS_WEB_PARTITION,
      allowpopups: "true",
      style: visible ? visibleWebviewStyle : hiddenWebviewStyle,
    });
  }

  #attach = (node: (HTMLElement & IWebviewNode) | null): void => {
    if (node === null || node === this.#node) {
      return;
    }
    this.#node = node;
    node.addEventListener("dom-ready", () => {
      log("info", "nexus free session webview ready", { url: node.getURL?.() });
      nexusWebSession.attachWebview(node);
    });
  };

  #onDone = (): void => {
    nexusWebSession.finishPrompt();
  };

  #onCancel = (): void => {
    nexusWebSession.cancelPrompt();
  };
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-start",
};

const headerStyle: React.CSSProperties = {
  position: "fixed",
  top: "4%",
  left: "12%",
  width: "76%",
  zIndex: 10002,
  color: "#fff",
  textAlign: "center",
  textShadow: "0 1px 2px rgba(0,0,0,0.8)",
};

const footerStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "4%",
  left: 0,
  width: "100%",
  zIndex: 10002,
  display: "flex",
  justifyContent: "center",
};

/** Centered panel the webview fills while a prompt is up. */
const visibleWebviewStyle: React.CSSProperties = {
  position: "fixed",
  top: "16%",
  left: "12%",
  width: "76%",
  height: "68%",
  zIndex: 10001,
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  background: "#fff",
};

/** Parked offscreen but still rendered, so the logged-in session keeps running between mints. */
const hiddenWebviewStyle: React.CSSProperties = {
  position: "fixed",
  left: -10000,
  top: -10000,
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
};

export default NexusFreeSessionView;
