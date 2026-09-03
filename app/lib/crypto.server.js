import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const encryptionKey = () => {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY or SHOPIFY_API_SECRET is required");
  return createHash("sha256").update(secret).digest();
};

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value) {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
