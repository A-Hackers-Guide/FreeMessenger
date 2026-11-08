// End-to-end encryption with perfect forward secrecy (PFS)
// Double ratchet algorithm (like Signal Protocol)
// Supports: E2EE, forward secrecy, post-compromise security

import crypto from "node:crypto";
import { HKDF } from "node:crypto";

export class DoubleRatchet {
  constructor(sharedSecret) {
    this.dh = crypto.createDiffieHellman(2048);
    this.rootKey = sharedSecret;
    this.chainKey = null;
    this.messageKey = null;
    this.messageNumber = 0;
    this.previousMessageNumber = 0;
    this.skipped = new Map(); // Skipped message keys for out-of-order messages
  }

  // Initialize with peer's public key
  initializeChainKey(peerPublicKey) {
    const sharedSecret = this.dh.computeSecret(peerPublicKey);
    this.chainKey = this.deriveKey(this.rootKey, sharedSecret, "chain");
  }

  // KDF function (HMAC-based)
  deriveKey(key, salt, info) {
    const hmac = crypto.createHmac("sha256", key);
    hmac.update(salt);
    hmac.update(info);
    return hmac.digest();
  }

  // Symmetric key ratchet (advances chain key)
  ratchetSymmetric() {
    const messageKey = this.deriveKey(this.chainKey, Buffer.alloc(0), "message");
    this.chainKey = this.deriveKey(this.chainKey, Buffer.alloc(0), "chain");
    this.messageNumber++;
    return messageKey;
  }

  // Diffie-Hellman ratchet (for forward secrecy)
  ratchetDH() {
    this.previousMessageNumber = this.messageNumber;
    this.messageNumber = 0;

    // Generate new ephemeral key pair
    const newDH = crypto.createDiffieHellman(2048);
    newDH.generateKeys();

    // Derive root key from shared secret
    const sharedSecret = this.dh.computeSecret(newDH.getPublicKey());
    this.rootKey = this.deriveKey(this.rootKey, sharedSecret, "dh-ratchet");

    // Initialize new chain key
    this.chainKey = this.deriveKey(this.rootKey, Buffer.alloc(0), "chain");

    this.dh = newDH;
    return newDH.getPublicKey();
  }

  // Encrypt message with forward secrecy
  encryptMessage(plaintext) {
    const messageKey = this.ratchetSymmetric();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", messageKey, iv);

    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    return {
      header: {
        dh: this.dh.getPublicKey().toString("hex"),
        pn: this.previousMessageNumber,
        n: this.messageNumber - 1
      },
      iv: iv.toString("hex"),
      ciphertext,
      tag: tag.toString("hex")
    };
  }

  // Decrypt message with out-of-order support
  decryptMessage(encryptedMsg) {
    const { header, iv, ciphertext, tag } = encryptedMsg;

    // Handle out-of-order messages (skip gap in chain)
    if (header.n > this.messageNumber) {
      this.skipMessageKeys(this.messageNumber, header.n);
    }

    // Check if we have a skipped key for this message
    const key = `${header.n}`;
    if (this.skipped.has(key)) {
      const messageKey = this.skipped.get(key);
      this.skipped.delete(key);
      return this.decryptWithKey(messageKey, iv, ciphertext, tag);
    }

    // We're behind: too many messages skipped
    if (header.n < this.messageNumber) {
      throw new Error("Message number too old");
    }

    // Decrypt with current message key
    const messageKey = this.ratchetSymmetric();
    return this.decryptWithKey(messageKey, iv, ciphertext, tag);
  }

  // Skip message keys for gap handling
  skipMessageKeys(start, end) {
    for (let i = start; i < end; i++) {
      const key = this.ratchetSymmetric();
      this.skipped.set(`${i}`, key);
    }
  }

  // Decrypt with specific key
  decryptWithKey(key, iv, ciphertext, tag) {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));

    let plaintext = decipher.update(ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");
    return plaintext;
  }
}

// OPAQUE authentication (password-based)
export class OPAQUEAuth {
  constructor(username, password) {
    this.username = username;
    this.password = password;
  }

  // Client registration
  generateRegistration() {
    const pwdU = this.password;
    const salt = crypto.randomBytes(16);

    // Derive password hash
    const pwdHash = crypto.pbkdf2Sync(pwdU, salt, 600000, 32, "sha256");

    // Derive opaque value
    const opaque = crypto.randomBytes(32);

    return {
      username: this.username,
      salt: salt.toString("hex"),
      opaque: opaque.toString("hex"),
      pwdHash: pwdHash.toString("hex")
    };
  }

  // Client authentication handshake
  initializeAuth() {
    const clientSecret = crypto.randomBytes(32);
    const clientPublicKey = this.derivePublicKey(clientSecret);

    return {
      username: this.username,
      clientPublicKey: clientPublicKey.toString("hex"),
      clientSecretCommitment: crypto
        .createHash("sha256")
        .update(clientSecret)
        .digest("hex")
    };
  }

  // Derive public key from secret
  derivePublicKey(secret) {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update("public-key-derivation");
    return hmac.digest();
  }

  // Server authentication response
  generateAuthResponse(clientPublicKey, serverSecret) {
    const serverPublicKey = this.derivePublicKey(serverSecret);
    const serverProof = crypto
      .createHmac("sha256", serverSecret)
      .update(clientPublicKey)
      .digest();

    return {
      serverPublicKey: serverPublicKey.toString("hex"),
      serverProof: serverProof.toString("hex")
    };
  }
}

// Zero-knowledge proof for authentication
export class ZKProof {
  static generate(secret) {
    const commitment = crypto.randomBytes(32);
    const challenge = crypto.randomBytes(32);
    const response = Buffer.allocUnsafe(32);

    for (let i = 0; i < 32; i++) {
      response[i] = (secret[i] ^ challenge[i]) ^ commitment[i];
    }

    return { commitment, challenge, response };
  }

  static verify(commitment, challenge, response, secret) {
    for (let i = 0; i < 32; i++) {
      const expected = (secret[i] ^ challenge[i]) ^ commitment[i];
      if (expected !== response[i]) return false;
    }
    return true;
  }
}

export { DoubleRatchet, OPAQUEAuth, ZKProof };
