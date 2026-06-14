import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { config } from "../config";

let cachedToken: { token: string; expiresAt: number } | undefined;

export const getAppleMusicDeveloperToken = () => {
  if (config.appleMusicDeveloperToken) return config.appleMusicDeveloperToken;
  if (!config.appleMusicTeamId || !config.appleMusicKeyId || !config.appleMusicPrivateKeyPath) return "";
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + 60 * 60 * 24 * 30;
  const header = {
    alg: "ES256",
    kid: config.appleMusicKeyId,
    typ: "JWT",
  };
  const payload = {
    iss: config.appleMusicTeamId,
    iat: nowSeconds,
    exp: expiresAtSeconds,
  };

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const privateKey = createPrivateKey(readFileSync(config.appleMusicPrivateKeyPath, "utf8"));
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  cachedToken = {
    token: `${signingInput}.${base64Url(signature)}`,
    expiresAt: expiresAtSeconds * 1000,
  };
  return cachedToken.token;
};

const base64UrlJson = (value: unknown) => base64Url(Buffer.from(JSON.stringify(value)));

const base64Url = (value: Buffer) =>
  value
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
