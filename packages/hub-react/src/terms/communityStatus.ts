import type { HubClient } from '../client.js';
import type { CommunityStatus } from '../types.js';

// One answer of `GET /community` per client for as long as the page lives: opening the editor on another row does not ask again. A
// failed answer is not remembered, so one dropped request does not hide the community disclosures until the page is reloaded.
const asked = new WeakMap<HubClient, Promise<CommunityStatus | null>>();

/** The server's answer about the community list, or null when it could not be read (the next call asks again). */
export function communityStatus(client: HubClient): Promise<CommunityStatus | null> {
  let answer = asked.get(client);
  if (answer === undefined) {
    const own: Promise<CommunityStatus | null> = client.community().then(
      (status) => status,
      () => {
        if (asked.get(client) === own) asked.delete(client);
        return null;
      },
    );
    answer = own;
    asked.set(client, answer);
  }
  return answer;
}
