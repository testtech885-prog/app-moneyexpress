"use strict";

const { createHmac } = require("node:crypto");
const { isIP } = require("node:net");

const API_PATH = /^\/api\/(?:health|auth\/(?:session|register|login|logout|password)|requests(?:\/[A-Za-z0-9-]+\/status)?)$/;
const FORWARDED_HEADERS = ["accept", "content-type", "cookie", "origin"];
const RETURNED_HEADERS = ["cache-control", "content-type", "retry-after"];
const MAX_BODY_SIZE = 16_384;

function jsonResponse(statusCode, error) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify({ error }),
  };
}

function getBackendOrigin() {
  const configured = process.env.MONEY_EXPRESS_API_ORIGIN?.trim();
  if (!configured) {
    throw new Error("Configurez MONEY_EXPRESS_API_ORIGIN dans les variables d’environnement Netlify.");
  }

  const origin = new URL(configured);
  if (
    origin.protocol !== "https:"
    || !origin.hostname
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.hostname === "localhost"
    || origin.hostname.endsWith(".localhost")
  ) {
    throw new Error("MONEY_EXPRESS_API_ORIGIN doit être une origine HTTPS publique sans chemin.");
  }

  const proxySecret = process.env.NETLIFY_PROXY_SECRET;
  if (typeof proxySecret !== "string" || Buffer.byteLength(proxySecret) < 32) {
    throw new Error("Configurez NETLIFY_PROXY_SECRET comme secret partagé de 32 caractères minimum.");
  }

  return origin;
}

function requestPath(event) {
  const functionPrefix = "/.netlify/functions/api";
  let suffix;
  if (event.path.startsWith(functionPrefix)) {
    suffix = event.path.slice(functionPrefix.length);
  } else if (event.path.startsWith("/api/")) {
    suffix = event.path.slice(4);
  } else {
    return "";
  }
  return `/api${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function requestHeaders(incomingHeaders) {
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = incomingHeaders[name] || incomingHeaders[name.toLowerCase()];
    if (value) headers[name] = value;
  }
  return headers;
}

exports.handler = async (event) => {
  let backend;
  try {
    backend = getBackendOrigin();
  } catch (error) {
    console.error("Proxy Money Express non configuré :", error.message);
    return jsonResponse(503, "Le serveur sécurisé n’est pas encore configuré.");
  }

  const pathname = requestPath(event);
  if (!API_PATH.test(pathname)) {
    return jsonResponse(404, "Cette adresse API n’existe pas.");
  }

  const target = new URL(pathname, backend);
  const rawQuery = event.rawQuery;
  const query = rawQuery
    ? rawQuery.replace(/^\?/, "")
    : new URLSearchParams(event.queryStringParameters || {}).toString();
  if (query) target.search = query;

  const headers = requestHeaders(event.headers || {});
  const incomingIp = event.headers?.["x-nf-client-connection-ip"]
    || event.headers?.["X-Nf-Client-Connection-Ip"];
  if (!incomingIp || isIP(incomingIp) === 0) {
    return jsonResponse(400, "La requête ne contient pas d’adresse réseau valide.");
  }
  headers["x-moneyexpress-client-ip"] = incomingIp;
  headers["x-moneyexpress-proxy-signature"] = createHmac("sha256", process.env.NETLIFY_PROXY_SECRET)
    .update(incomingIp)
    .digest("hex");
  let body;
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "utf8");
    if (body.byteLength > MAX_BODY_SIZE) {
      return jsonResponse(413, "Le contenu envoyé est trop volumineux.");
    }
  }

  try {
    const result = await fetch(target, {
      method: event.httpMethod,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const responseHeaders = { "x-content-type-options": "nosniff" };
    for (const name of RETURNED_HEADERS) {
      const value = result.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const cookies = result.headers.getSetCookie();
    const responseBody = Buffer.from(await result.arrayBuffer());
    return {
      statusCode: result.status,
      headers: responseHeaders,
      ...(cookies.length ? { multiValueHeaders: { "set-cookie": cookies } } : {}),
      ...(responseBody.byteLength
        ? { body: responseBody.toString("base64"), isBase64Encoded: true }
        : { body: "" }),
    };
  } catch (error) {
    console.error("Impossible de joindre le serveur MONEY express.", error.message);
    return jsonResponse(502, "Le serveur Money Express est temporairement indisponible.");
  }
};
