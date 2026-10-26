import type NexusT from "@nexusmods/nexus-api";
import { getErrorMessageOrDefault } from "@vortex/shared";

import { log } from "../../../logging";
import type NXMUrl from "../NXMUrl";
import { getInfoGraphQL, nexusGames } from "../util";
import { MintFailed } from "./errors";
import { nexusWebSession } from "./nexusWebSession";

/**
 * Mint an authorised (keyed) nxm link for a keyless mod-file link, using the embedded logged-in
 * Nexus session. Throws a typed error (see ./errors) when it can't, so the caller can fall back to
 * the stock website dialog without regressing anything.
 *
 * `pageId` is the Nexus page/domain for the game (e.g. "skyrimspecialedition"); the website's
 * GenerateDownloadUrl call wants the game's *numeric* id, which we look up from the games list
 * Vortex already fetched, falling back to a GraphQL mod-info query.
 */
export async function mintFreeDownloadLink(
  nexus: NexusT,
  url: NXMUrl,
  pageId: string,
): Promise<string> {
  const numericGameId = await resolveNumericGameId(nexus, pageId, url.modId, url.fileId);
  if (numericGameId === undefined) {
    throw new MintFailed(`no numeric game id for domain ${pageId}`);
  }
  return nexusWebSession.mint(pageId, numericGameId, url.modId, url.fileId);
}

async function resolveNumericGameId(
  nexus: NexusT,
  domain: string,
  modId: number,
  fileId: number,
): Promise<number | undefined> {
  const fromList = nexusGames().find((game) => game.domain_name === domain)?.id;
  if (typeof fromList === "number") {
    return fromList;
  }

  try {
    const { modInfo } = await getInfoGraphQL(nexus, domain, modId, fileId);
    const gid = (modInfo as { game_id?: number } | undefined)?.game_id;
    return typeof gid === "number" ? gid : undefined;
  } catch (err) {
    log("warn", "could not resolve numeric game id for free download", {
      domain,
      error: getErrorMessageOrDefault(err),
    });
    return undefined;
  }
}
