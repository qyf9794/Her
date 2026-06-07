import crypto from "node:crypto";
import type { RequestHandler } from "express";

export type LocalApiAuth = {
  token: string;
};

export const createLocalApiAuth = (): LocalApiAuth => ({
  token: crypto.randomBytes(32).toString("base64url"),
});

export const requireLocalApiAuth =
  (auth: LocalApiAuth): RequestHandler =>
  (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !constantTimeEqual(match[1], auth.token)) {
      res.status(401).json({ error: "Unauthorized local API request." });
      return;
    }

    next();
  };

const constantTimeEqual = (value: string, expected: string) => {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (valueBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
};
