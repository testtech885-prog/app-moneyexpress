"use strict";

const { createServer } = require("node:http");
const { isIP } = require("node:net");
const { createHmac, createHash, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { mkdirSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(scryptCallback);
const root = __dirname;
const databasePath = resolve(process.env.MONEY_EXPRESS_DB_PATH || `${root}/data/money-express.sqlite`);
const production = process.env.NODE_ENV === "production";
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS || (production ? "" : "localhost,127.0.0.1"))
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const cookieName = production ? "__Host-moneyexpress_session" : "moneyexpress_session";
const sessionLifetime = 7 * 24 * 60 * 60;
const passwordParameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const requestStatuses = new Set(["pending", "processing", "completed", "rejected"]);
const serviceTypes = new Set([
  "Billet d’avion",
  "Assurance automobile",
  "Offres NSIA",
  "Mobile Money",
  "Airtel Money",
  "Western Union",
  "Express Union",
  "Canal+ & CanalBox",
  "Autre demande",
]);
const transferServices = new Set(["Western Union", "Express Union", "Mobile Money", "Airtel Money"]);
const rateLimits = new Map();
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/auth.css", ["auth.css", "text/css; charset=utf-8"]],
  ["/branding.css", ["branding.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/assets/money-express-logo.jpg", ["logo.jpg", "image/jpeg"]],
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`La variable d’environnement ${name} est obligatoire.`);
  return value;
}

function passwordValid(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function passwordHash(password, salt = randomBytes(16)) {
  return scrypt(password, salt, 64, passwordParameters).then((key) => ({
    salt: salt.toString("base64url"),
    hash: Buffer.from(key).toString("base64url"),
  }));
}

async function passwordMatches(password, account) {
  const salt = Buffer.from(account.password_salt, "base64url");
  const expected = Buffer.from(account.password_hash, "base64url");
  const result = Buffer.from(await scrypt(password, salt, 64, passwordParameters));
  return expected.length === result.length && timingSafeEqual(expected, result);
}

function hashSession(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    let bodySize = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > 16_384) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        rejectBody(httpError(413, "Le contenu envoyé est trop volumineux."));
        return;
      }
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          rejectBody(httpError(400, "Le format des données est invalide."));
          return;
        }
        resolveBody(parsed);
      } catch {
        rejectBody(httpError(400, "Le format des données est invalide."));
      }
    });
    request.on("error", rejectBody);
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(response, status, body, additionalHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...additionalHeaders,
  });
  response.end(JSON.stringify(body));
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; img-src 'self' data: https://www.google.com",
  );
}

function enforceSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw httpError(403, "Origine de la requête manquante.");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw httpError(403, "Origine de la requête invalide.");
  }
  const expectedOrigin = process.env.APP_ORIGIN?.trim();
  const actualOrigin = expectedOrigin
    ? new URL(expectedOrigin).origin
    : `${production ? "https" : "http"}://${request.headers.host.toLowerCase()}`;
  if (parsedOrigin.origin !== actualOrigin || (production && parsedOrigin.protocol !== "https:")) {
    throw httpError(403, "Origine de la requête non autorisée.");
  }
}

function enforceHost(request) {
  const hostHeader = request.headers.host;
  if (!hostHeader) throw httpError(400, "Nom d’hôte manquant.");
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    throw httpError(400, "Nom d’hôte invalide.");
  }
  if (!allowedHosts.has(hostname)) throw httpError(400, "Nom d’hôte non autorisé.");
}

function getCookie(request) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return "";
}

function sessionCookie(token) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime}${production ? "; Secure" : ""}`;
}

function expiredCookie() {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? "; Secure" : ""}`;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function checkRateLimit(request, action, limit, subject = "ip") {
  const address = getClientAddress(request);
  const key = `${action}:${address}:${subject}`;
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.until < now) {
    rateLimits.set(key, { count: 1, until: now + 15 * 60 * 1000 });
    return;
  }
  if (current.count >= limit) {
    throw httpError(429, "Trop de tentatives. Réessayez dans quelques minutes.");
  }
  current.count += 1;
}

function getClientAddress(request) {
  const forwardedAddress = request.headers["x-moneyexpress-client-ip"];
  const signature = request.headers["x-moneyexpress-proxy-signature"];
  const secret = process.env.NETLIFY_PROXY_SECRET;

  if (secret && typeof forwardedAddress === "string" && typeof signature === "string" && isIP(forwardedAddress)) {
    const expected = createHmac("sha256", secret).update(forwardedAddress).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      return forwardedAddress;
    }
  }

  return request.socket.remoteAddress || "unknown";
}

async function start() {
  const adminEmail = requiredEnvironment("ADMIN_EMAIL").toLowerCase();
  const adminName = requiredEnvironment("ADMIN_NAME");
  const adminPassword = requiredEnvironment("ADMIN_PASSWORD");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 254) {
    throw new Error("ADMIN_EMAIL doit être une adresse e-mail valide de 254 caractères maximum.");
  }
  if (!passwordValid(adminPassword)) {
    throw new Error("ADMIN_PASSWORD doit contenir entre 12 et 128 caractères.");
  }
  if (production && process.env.ALLOW_INSECURE_HTTP === "true") {
    throw new Error("ALLOW_INSECURE_HTTP ne peut pas être activé en production.");
  }
  if (production && allowedHosts.size === 0) {
    throw new Error("En production, renseignez ALLOWED_HOSTS avec le nom de domaine HTTPS de l’application.");
  }
  if (production) {
    const proxySecret = process.env.NETLIFY_PROXY_SECRET;
    if (typeof proxySecret !== "string" || Buffer.byteLength(proxySecret) < 32) {
      throw new Error("En production, NETLIFY_PROXY_SECRET doit contenir au moins 32 caractères.");
    }
    const appOrigin = process.env.APP_ORIGIN?.trim();
    if (!appOrigin) {
      throw new Error("En production, APP_ORIGIN doit contenir l’origine HTTPS exacte du site Netlify.");
    }
    let parsedAppOrigin;
    try {
      parsedAppOrigin = new URL(appOrigin);
    } catch {
      throw new Error("APP_ORIGIN doit contenir une URL HTTPS valide, par exemple https://money-express.netlify.app.");
    }
    if (parsedAppOrigin.protocol !== "https:" || parsedAppOrigin.origin !== appOrigin || parsedAppOrigin.pathname !== "/") {
      throw new Error("APP_ORIGIN doit être une origine HTTPS exacte sans chemin, par exemple https://money-express.netlify.app.");
    }
  }

  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'transfer')),
      service TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      amount INTEGER,
      currency TEXT,
      recipient TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'prepared')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_user_created ON requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at DESC);
  `);

  const existingAdmin = database.prepare("SELECT id, role FROM users WHERE email = ?").get(adminEmail);
  if (existingAdmin && existingAdmin.role !== "admin") {
    throw new Error("ADMIN_EMAIL est déjà utilisé par un compte client. Utilisez une autre adresse administrateur.");
  }
  if (!existingAdmin) {
    const credentials = await passwordHash(adminPassword);
    database.prepare(
      "INSERT INTO users (id, email, name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)",
    ).run(randomBytes(16).toString("hex"), adminEmail, adminName, credentials.salt, credentials.hash, new Date().toISOString());
    console.info(`Compte administrateur initial créé pour ${adminEmail}.`);
  }

  function getSession(request) {
    const token = getCookie(request);
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const session = database.prepare(`
      SELECT users.id, users.email, users.name, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashSession(token), Date.now());
    return session || null;
  }

  function requireUser(request) {
    const user = getSession(request);
    if (!user) throw httpError(401, "Votre session a expiré. Veuillez vous reconnecter.");
    return user;
  }

  function requireAdmin(request) {
    const user = requireUser(request);
    if (user.role !== "admin") throw httpError(403, "Cette fonctionnalité est réservée à l’administration.");
    return user;
  }

  function formatRequest(row) {
    return {
      id: row.id,
      kind: row.kind,
      service: row.service,
      details: row.details,
      name: row.name,
      phone: row.phone,
      amount: row.amount,
      currency: row.currency,
      recipient: row.recipient,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.email ? { email: row.email, name: row.user_name } : {}),
    };
  }

  async function routeApi(request, response, url) {
    const { pathname } = url;
    if (request.method !== "GET" && request.method !== "HEAD") enforceSameOrigin(request);

    if (pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/auth/session" && request.method === "GET") {
      const user = getSession(request);
      sendJson(response, 200, { user: user ? publicUser(user) : null });
      return;
    }

    if (pathname === "/api/auth/register" && request.method === "POST") {
      checkRateLimit(request, "register-ip", 20);
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      checkRateLimit(request, "register-email", 5, email || "invalid");
      const password = body.password;
      if (name.length < 2 || name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !passwordValid(password)) {
        throw httpError(400, "Renseignez un nom valide, une adresse e-mail valide et un mot de passe d’au moins 12 caractères.");
      }
      const credentials = await passwordHash(password);
      const user = { id: randomBytes(16).toString("hex"), name, email, role: "client" };
      try {
        database.prepare(
          "INSERT INTO users (id, email, name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, 'client', ?, ?, ?)",
        ).run(user.id, email, name, credentials.salt, credentials.hash, new Date().toISOString());
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) {
          throw httpError(409, "Un compte utilise déjà cette adresse e-mail. Connectez-vous ou choisissez une autre adresse.");
        }
        throw error;
      }
      const token = randomBytes(32).toString("base64url");
      database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
        hashSession(token), user.id, Date.now() + sessionLifetime * 1000,
      );
      sendJson(response, 201, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token) });
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      checkRateLimit(request, "login-ip", 80);
      const body = await readJson(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      checkRateLimit(request, "login-email", 8, email || "invalid");
      const password = typeof body.password === "string" && body.password.length <= 128 ? body.password : "";
      const account = database.prepare("SELECT * FROM users WHERE email = ?").get(email);
      const dummyAccount = { password_salt: "AAAAAAAAAAAAAAAAAAAAAA", password_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
      const valid = await passwordMatches(password || "invalid-password", account || dummyAccount);
      if (!account || !valid) throw httpError(401, "Adresse e-mail ou mot de passe incorrect.");
      database.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(account.id, Date.now());
      const token = randomBytes(32).toString("base64url");
      database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
        hashSession(token), account.id, Date.now() + sessionLifetime * 1000,
      );
      sendJson(response, 200, { user: publicUser(account) }, { "Set-Cookie": sessionCookie(token) });
      return;
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const token = getCookie(request);
      if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSession(token));
      sendJson(response, 200, { ok: true }, { "Set-Cookie": expiredCookie() });
      return;
    }

    if (pathname === "/api/auth/password" && request.method === "POST") {
      const user = requireUser(request);
      const body = await readJson(request);
      if (!passwordValid(body.currentPassword) || !passwordValid(body.newPassword)) {
        throw httpError(400, "Le mot de passe actuel et le nouveau doivent contenir entre 12 et 128 caractères.");
      }
      if (body.currentPassword === body.newPassword) {
        throw httpError(400, "Choisissez un nouveau mot de passe différent de l’actuel.");
      }
      const account = database.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
      if (!await passwordMatches(body.currentPassword, account)) {
        throw httpError(400, "Le mot de passe actuel est incorrect.");
      }
      const credentials = await passwordHash(body.newPassword);
      const currentTokenHash = hashSession(getCookie(request));
      database.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?")
        .run(credentials.salt, credentials.hash, user.id);
      database.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
        .run(user.id, currentTokenHash);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === "/api/requests" && request.method === "GET") {
      const user = requireUser(request);
      const rows = user.role === "admin"
        ? database.prepare(`
            SELECT requests.*, users.email, users.name AS user_name FROM requests JOIN users ON users.id = requests.user_id
            ORDER BY requests.created_at DESC LIMIT 200
          `).all()
        : database.prepare("SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(user.id);
      sendJson(response, 200, { requests: rows.map(formatRequest) });
      return;
    }

    if (pathname === "/api/requests" && request.method === "POST") {
      const user = requireUser(request);
      if (user.role !== "client") throw httpError(403, "Seuls les comptes client peuvent soumettre une demande.");
      const body = await readJson(request);
      const kind = body.kind === "transfer" ? "transfer" : body.kind === "request" ? "request" : "";
      const service = typeof body.service === "string" ? body.service : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const details = typeof body.details === "string" ? body.details.trim() : "";
      const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
      const amount = Number(body.amount);
      const currency = typeof body.currency === "string" ? body.currency : "";
      const supportedService = kind === "transfer" ? transferServices.has(service) : serviceTypes.has(service);
      if (!kind || !supportedService || phone.length < 5 || phone.length > 32) {
        throw httpError(400, "Vérifiez le type de demande, le service choisi et le numéro de téléphone.");
      }
      if (kind === "request" && (name.length < 2 || name.length > 100 || details.length > 1000)) {
        throw httpError(400, "Vérifiez votre nom et limitez les précisions à 1 000 caractères.");
      }
      if (kind === "transfer" && (
        !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000
        || !new Set(["FCFA", "EUR", "USD"]).has(currency) || recipient.length < 2 || recipient.length > 100
      )) {
        throw httpError(400, "Vérifiez le montant, la devise et le nom du bénéficiaire.");
      }
      const now = new Date().toISOString();
      const id = `${kind === "transfer" ? "TR" : "DE"}-${randomUUID().toUpperCase()}`;
      database.prepare(`
        INSERT INTO requests (id, user_id, kind, service, details, name, phone, amount, currency, recipient, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, user.id, kind, service, details, name, phone,
        kind === "transfer" ? amount : null,
        kind === "transfer" ? currency : null,
        kind === "transfer" ? recipient : null,
        kind === "transfer" ? "prepared" : "pending",
        now, now,
      );
      const created = database.prepare("SELECT * FROM requests WHERE id = ?").get(id);
      sendJson(response, 201, { request: formatRequest(created) });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/requests\/([A-Za-z0-9-]+)\/status$/);
    if (statusMatch && request.method === "PATCH") {
      requireAdmin(request);
      const body = await readJson(request);
      if (!requestStatuses.has(body.status)) throw httpError(400, "Le statut demandé n’est pas valide.");
      const changed = database.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?")
        .run(body.status, new Date().toISOString(), statusMatch[1]);
      if (!changed.changes) throw httpError(404, "Cette demande n’existe plus.");
      const updated = database.prepare(
        "SELECT requests.*, users.email, users.name AS user_name FROM requests JOIN users ON users.id = requests.user_id WHERE requests.id = ?",
      ).get(statusMatch[1]);
      sendJson(response, 200, { request: formatRequest(updated) });
      return;
    }

    throw httpError(404, "Cette adresse API n’existe pas.");
  }

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      enforceHost(request);
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await routeApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw httpError(405, "Cette méthode n’est pas autorisée.");
      }
      const file = staticFiles.get(url.pathname);
      if (!file) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Page introuvable.");
        return;
      }
      const [filename, contentType] = file;
      const data = readFileSync(resolve(root, filename));
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
      });
      response.end(data);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error("Erreur serveur MONEY express.", error);
      sendJson(response, status, { error: status === 500 ? "Une erreur inattendue est survenue." : error.message });
    }
  });

  const cleanupTimer = setInterval(() => {
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    const now = Date.now();
    for (const [key, bucket] of rateLimits) {
      if (bucket.until <= now) rateLimits.delete(key);
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.info(`Money Express Mobile disponible sur http://${host}:${port}`);
    console.info(`Base de données : ${databasePath}`);
  });

  function shutdown(signal) {
    console.info(`${signal} : fermeture du serveur.`);
    clearInterval(cleanupTimer);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Impossible de démarrer Money Express Mobile :", error.message);
  process.exitCode = 1;
});
