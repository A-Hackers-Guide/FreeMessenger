// Bundled into crypto-fallback.min.js, loaded only when the browser has no
// usable WebCrypto (see crypto.js).
import { p256 } from "@noble/curves/p256";
import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha2";

window.FMNoble = { p256, gcm, sha256 };
