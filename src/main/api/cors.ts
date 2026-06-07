import type { RequestHandler } from "express";

const devOrigins = new Set(["http://127.0.0.1:5174", "http://localhost:5174"]);
const allowedFetchSites = new Set(["same-origin", "same-site", "none"]);

export const isAllowedLocalApiOrigin = (origin: string | undefined, isPackaged: boolean) =>
  !origin || (!isPackaged && devOrigins.has(origin));

export const localApiCors =
  (isPackaged: boolean): RequestHandler =>
  (req, res, next) => {
    const origin = req.get("origin");
    if (origin && isAllowedLocalApiOrigin(origin, isPackaged)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (req.method === "OPTIONS") {
      if (!isAllowedLocalApiOrigin(origin, isPackaged)) {
        res.status(403).json({ error: "Untrusted local API origin." });
        return;
      }
      res.sendStatus(204);
      return;
    }

    next();
  };

export const requireTrustedLocalApiRequest =
  (isPackaged: boolean): RequestHandler =>
  (req, res, next) => {
    const origin = req.get("origin");
    if (!isAllowedLocalApiOrigin(origin, isPackaged)) {
      res.status(403).json({ error: "Untrusted local API origin." });
      return;
    }

    const fetchSite = req.get("sec-fetch-site");
    if (fetchSite && !allowedFetchSites.has(fetchSite.toLowerCase())) {
      res.status(403).json({ error: "Untrusted local API fetch site." });
      return;
    }

    next();
  };
