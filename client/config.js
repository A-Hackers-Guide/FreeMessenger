// Where the relay lives. The GitHub Actions deploy rewrites this file with the
// real Worker URL, so you never have to edit it by hand.
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
export const RELAY_URL = local ? `http://${location.hostname}:8787` : "https://freemessenger-relay.a-hackers-guide.workers.dev";
