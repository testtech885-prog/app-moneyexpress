"use strict";

const { createServer } = require("node:http");
const { isIP } = require("node:net");
const { createHmac, createHash, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(scryptCallback);
const root = __dirname;
const databasePath = resolve(process.env.MONEY_EXPRESS_DB_PATH || `${root}/data/money-express.sqlite`);
const uploadsPath = resolve(root, "uploads");
mkdirSync(uploadsPath, { recursive: true });
const production = process.env.NODE_ENV === "production";
const configuredHosts = [
  process.env.ALLOWED_HOSTS || (production ? "app-moneyexpress-1.onrender.com,delicate-panda-64c849.netlify.app" : "localhost,127.0.0.1"),
  process.env.RENDER_EXTERNAL_HOSTNAME,
].filter(Boolean).join(",");

const allowedHosts = new Set(
  configuredHosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const cookieName = production ? "__Host-moneyexpress_session" : "moneyexpress_session";
const sessionLifetime = 7 * 24 * 60 * 60;
const passwordParameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const requestStatuses = new Set(["pending", "processing", "completed", "rejected"]);
const wuOperations = new Set(["envoi", "retrait"]);
const mobileOperations = new Set(["envoi", "retrait"]);
const wuSendTypes = new Set(["normal", "direct_to_bank"]);
const agencies = ["Agence Massengo", "Agence Kinsoudi", "Agence Mfilou"];
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
  ["/favicon.ico", ["logo.jpg", "image/jpeg"]],
]);
const uploadMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

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

function readMultipart(request) {
  return new Promise((resolveBody, rejectBody) => {
    const contentType = request.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!boundaryMatch) { rejectBody(httpError(400, "Boundary multipart manquant.")); return; }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks = [];
    let bodySize = 0;
    request.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > 6 * 1024 * 1024) { rejectBody(httpError(413, "Le fichier est trop volumineux (max 5 Mo).")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = {};
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        let pos = 0;
        while (pos < buffer.length) {
          const start = buffer.indexOf(boundaryBuffer, pos);
          if (start === -1) break;
          const nextStart = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
          if (nextStart === -1) break;
          const partData = buffer.subarray(start + boundaryBuffer.length, nextStart);
          const headerEnd = partData.indexOf("\r\n\r\n");
          if (headerEnd === -1) { pos = nextStart; continue; }
          const headers = partData.subarray(0, headerEnd).toString();
          const body = partData.subarray(headerEnd + 4, partData.length - 2);
          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
          if (nameMatch) {
            if (filenameMatch) {
              parts[nameMatch[1]] = { filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream", data: body };
            } else {
              parts[nameMatch[1]] = body.toString();
            }
          }
          pos = nextStart;
        }
        resolveBody(parts);
      } catch { rejectBody(httpError(400, "Erreur de lecture du formulaire.")); }
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
  const allowed = [
    process.env.APP_ORIGIN?.trim(),
    "https://delicate-panda-64c849.netlify.app",
    "https://app-moneyexpress-1.onrender.com",
    process.env.RENDER_EXTERNAL_URL,
    `${production ? "https" : "http"}://${request.headers.host ? request.headers.host.toLowerCase() : ""}`,
  ].filter(Boolean).map((o) => {
    try { return new URL(o).origin; } catch { return ""; }
  }).filter(Boolean);

  if (!allowed.includes(parsedOrigin.origin) && !parsedOrigin.hostname.endsWith(".netlify.app") && !parsedOrigin.hostname.endsWith(".onrender.com")) {
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
  if (!allowedHosts.has(hostname) && !hostname.endsWith(".onrender.com") && !hostname.endsWith(".netlify.app") && !hostname.endsWith(".localhost") && hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw httpError(400, "Nom d’hôte non autorisé.");
  }
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
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@moneyexpress.test").trim().toLowerCase();
  const adminName = process.env.ADMIN_NAME?.trim() || "Administrateur Money Express";
  const adminPassword = process.env.ADMIN_PASSWORD || "G5NkEwZ8kLTRTp8Lr6Ds3Psl9oH62Grz";
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
    const proxySecret = process.env.NETLIFY_PROXY_SECRET || "rhrwBM0ACt4pUSSQ001TySDM-rPuRTRofjACobXGBs8";
    if (typeof proxySecret !== "string" || Buffer.byteLength(proxySecret) < 32) {
      throw new Error("En production, NETLIFY_PROXY_SECRET doit contenir au moins 32 caractères.");
    }
    const appOrigin = process.env.APP_ORIGIN?.trim() || "https://delicate-panda-64c849.netlify.app";
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
      phone TEXT NOT NULL DEFAULT '',
      amount INTEGER,
      currency TEXT,
      recipient TEXT,
      country TEXT DEFAULT '',
      wu_operation TEXT DEFAULT '',
      send_type TEXT DEFAULT '',
      mtcn TEXT DEFAULT '',
      agency TEXT DEFAULT '',
      id_document TEXT DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'prepared')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_user_created ON requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, is_read, created_at DESC);
  `);

  /* Migration: add new columns if missing (existing DBs) */
  const existingCols = database.prepare("PRAGMA table_info(requests)").all().map(c => c.name);
  const migrations = [
    ["country", "TEXT DEFAULT ''"], ["wu_operation", "TEXT DEFAULT ''"],
    ["send_type", "TEXT DEFAULT ''"], ["mtcn", "TEXT DEFAULT ''"],
    ["agency", "TEXT DEFAULT ''"], ["id_document", "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of migrations) {
    if (!existingCols.includes(col)) database.exec(`ALTER TABLE requests ADD COLUMN ${col} ${def}`);
  }
  try { database.exec("CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, request_id TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"); } catch {}

  const existingAdmin = database.prepare("SELECT id, role FROM users WHERE email = ?").get(adminEmail);
  if (existingAdmin && existingAdmin.role !== "admin") {
    throw new Error("ADMIN_EMAIL est déjà utilisé par un compte client. Utilisez une autre adresse administrateur.");
  }
  const credentials = await passwordHash(adminPassword);
  if (!existingAdmin) {
    database.prepare(
      "INSERT INTO users (id, email, name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)",
    ).run(randomBytes(16).toString("hex"), adminEmail, adminName, credentials.salt, credentials.hash, new Date().toISOString());
    console.info(`Compte administrateur initial créé pour ${adminEmail}.`);
  } else {
    database.prepare(
      "UPDATE users SET password_salt = ?, password_hash = ?, name = ? WHERE id = ?",
    ).run(credentials.salt, credentials.hash, adminName, existingAdmin.id);
    console.info(`Compte administrateur synchronisé pour ${adminEmail}.`);
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
      country: row.country || "",
      wuOperation: row.wu_operation || "",
      sendType: row.send_type || "",
      mtcn: row.mtcn || "",
      agency: row.agency || "",
      idDocument: row.id_document || "",
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.email ? { email: row.email, userName: row.user_name, name: row.user_name || row.name } : {}),
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

      const isMultipart = (request.headers["content-type"] || "").includes("multipart/form-data");
      const body = isMultipart ? await readMultipart(request) : await readJson(request);

      const kind = (typeof body.kind === "string" ? body.kind : "") === "transfer" ? "transfer" : (typeof body.kind === "string" ? body.kind : "") === "request" ? "request" : "";
      const service = typeof body.service === "string" ? body.service : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const details = typeof body.details === "string" ? body.details.trim() : "";
      const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
      const amount = Number(body.amount || 0);
      const currency = typeof body.currency === "string" ? body.currency : "";
      const country = typeof body.country === "string" ? body.country.trim() : "";
      const wuOperation = typeof body.wu_operation === "string" ? body.wu_operation : "";
      const sendType = typeof body.send_type === "string" ? body.send_type : "";
      const mtcn = typeof body.mtcn === "string" ? body.mtcn.trim() : "";
      const agency = typeof body.agency === "string" ? body.agency : "";

      const supportedService = kind === "transfer" ? transferServices.has(service) : serviceTypes.has(service);

      /* Mobile Money & Airtel Money special flow for Retrait or Envoi with Agency */
      if ((service === "Mobile Money" || service === "Airtel Money") && kind === "transfer") {
        const op = typeof body.wu_operation === "string" ? body.wu_operation : (typeof body.operation_type === "string" ? body.operation_type : "envoi");
        if (op === "retrait") {
          if (!agencies.includes(agency)) throw httpError(400, "Veuillez choisir une agence pour le retrait.");
          if (recipient.length < 2 || recipient.length > 100) throw httpError(400, "Renseignez le nom du bénéficiaire.");
          if (phone.length < 5 || phone.length > 32) throw httpError(400, "Renseignez le numéro de compte mobile.");
          if (!Number.isSafeInteger(amount) || amount < 1) throw httpError(400, "Renseignez un montant valide.");
          if (!new Set(["FCFA", "EUR", "USD"]).has(currency)) throw httpError(400, "Choisissez une devise.");
          
          const now = new Date().toISOString();
          const prefix = service === "Mobile Money" ? "MM" : "AM";
          const id = `${prefix}-${randomUUID().toUpperCase()}`;
          database.prepare(`
            INSERT INTO requests (id, user_id, kind, service, details, name, phone, amount, currency, recipient, wu_operation, agency, status, created_at, updated_at)
            VALUES (?, ?, 'transfer', ?, ?, ?, ?, ?, ?, ?, 'retrait', ?, 'pending', ?, ?)
          `).run(
            id, user.id, service, details, name, phone, amount, currency, recipient, agency, now, now
          );
          database.prepare("INSERT INTO notifications (user_id, request_id, message, created_at) VALUES (?, ?, ?, ?)").run(
            user.id, id, `Votre demande ${id} (${service} Retrait) a bien été envoyée.`, now
          );
          const created = database.prepare("SELECT * FROM requests WHERE id = ?").get(id);
          sendJson(response, 201, { request: formatRequest(created) });
          return;
        }
      }

      /* Western Union special flow */
      if (service === "Western Union" && kind === "transfer") {
        if (!wuOperations.has(wuOperation)) throw httpError(400, "Choisissez envoi ou retrait.");
        if (!agencies.includes(agency)) throw httpError(400, "Veuillez choisir une agence.");

        let idDocumentFilename = "";
        if (wuOperation === "envoi") {
          if (recipient.length < 2 || recipient.length > 100) throw httpError(400, "Renseignez le nom du bénéficiaire.");
          if (country.length < 2 || country.length > 100) throw httpError(400, "Renseignez le pays du bénéficiaire.");
          if (!Number.isSafeInteger(amount) || amount < 1) throw httpError(400, "Renseignez un montant valide.");
          if (!new Set(["FCFA", "EUR", "USD"]).has(currency)) throw httpError(400, "Choisissez une devise.");
          if (!wuSendTypes.has(sendType)) throw httpError(400, "Choisissez le type d'envoi.");
          /* File upload */
          const idFile = body.id_document;
          if (idFile && typeof idFile === "object" && idFile.data) {
            if (!uploadMimeTypes.has(idFile.contentType)) throw httpError(400, "Format de pièce d'identité non supporté (JPG, PNG, WebP ou PDF).");
            if (idFile.data.length > 5 * 1024 * 1024) throw httpError(400, "Le fichier dépasse 5 Mo.");
            const ext = idFile.contentType === "application/pdf" ? ".pdf" : idFile.contentType === "image/png" ? ".png" : idFile.contentType === "image/webp" ? ".webp" : ".jpg";
            idDocumentFilename = `${randomBytes(16).toString("hex")}${ext}`;
            writeFileSync(resolve(uploadsPath, idDocumentFilename), idFile.data);
          }
        } else {
          /* retrait */
          if (mtcn.length < 4 || mtcn.length > 30) throw httpError(400, "Renseignez le MTCN.");
          if (recipient.length < 2 || recipient.length > 100) throw httpError(400, "Renseignez le nom du bénéficiaire.");
        }

        const now = new Date().toISOString();
        const id = `WU-${randomUUID().toUpperCase()}`;
        database.prepare(`
          INSERT INTO requests (id, user_id, kind, service, details, name, phone, amount, currency, recipient, country, wu_operation, send_type, mtcn, agency, id_document, status, created_at, updated_at)
          VALUES (?, ?, 'transfer', 'Western Union', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          id, user.id, details, name, phone,
          wuOperation === "envoi" ? amount : null,
          wuOperation === "envoi" ? currency : null,
          recipient, country, wuOperation, sendType, mtcn, agency, idDocumentFilename,
          now, now,
        );
        database.prepare("INSERT INTO notifications (user_id, request_id, message, created_at) VALUES (?, ?, ?, ?)").run(user.id, id, `Votre demande ${id} (Western Union ${wuOperation === "envoi" ? "Envoi" : "Retrait"}) a bien été envoyée.`, now);
        const created = database.prepare("SELECT * FROM requests WHERE id = ?").get(id);
        sendJson(response, 201, { request: formatRequest(created) });
        return;
      }

      /* Original flow for other services */
      if (!kind || !supportedService) {
        throw httpError(400, "Vérifiez le type de demande et le service choisi.");
      }
      if (kind === "request" && (name.length < 2 || name.length > 100 || details.length > 1000)) {
        throw httpError(400, "Vérifiez votre nom et limitez les précisions à 1 000 caractères.");
      }
      if (kind === "request" && phone.length < 5 || phone.length > 32) {
        throw httpError(400, "Vérifiez le numéro de téléphone.");
      }
      if (kind === "transfer" && (
        !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000
        || !new Set(["FCFA", "EUR", "USD"]).has(currency) || recipient.length < 2 || recipient.length > 100
        || phone.length < 5 || phone.length > 32
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
      database.prepare("INSERT INTO notifications (user_id, request_id, message, created_at) VALUES (?, ?, ?, ?)").run(user.id, id, `Votre demande ${id} (${kind === "transfer" ? "Transfert" : "Demande"} ${service}) a bien été envoyée.`, now);
      const created = database.prepare("SELECT * FROM requests WHERE id = ?").get(id);
      sendJson(response, 201, { request: formatRequest(created) });
      return;
    }

    /* GET single request detail (client sees own, admin sees any) */
    const detailMatch = pathname.match(/^\/api\/requests\/([A-Za-z0-9-]+)$/);
    if (detailMatch && request.method === "GET") {
      const user = requireUser(request);
      const row = user.role === "admin"
        ? database.prepare("SELECT requests.*, users.email, users.name AS user_name FROM requests JOIN users ON users.id = requests.user_id WHERE requests.id = ?").get(detailMatch[1])
        : database.prepare("SELECT requests.*, users.email, users.name AS user_name FROM requests JOIN users ON users.id = requests.user_id WHERE requests.id = ? AND requests.user_id = ?").get(detailMatch[1], user.id);
      if (!row) throw httpError(404, "Demande introuvable.");
      sendJson(response, 200, { request: formatRequest(row) });
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

      /* Notification client suite au traitement */
      const statusLabels = { pending: "En attente", prepared: "Préparé", processing: "En traitement", completed: "Terminé", rejected: "Refusé" };
      const label = statusLabels[body.status] || body.status;
      try {
        database.prepare("INSERT INTO notifications (user_id, request_id, message, created_at) VALUES (?, ?, ?, ?)")
          .run(updated.user_id, updated.id, `Votre demande ${statusMatch[1]} a été traitée. Statut actuel : ${label}.`, new Date().toISOString());
      } catch (err) {
        console.error("Erreur insertion notification:", err);
      }

      sendJson(response, 200, { request: formatRequest(updated) });
      return;
    }

    /* Notifications API */
    if (pathname === "/api/notifications" && request.method === "GET") {
      const user = requireUser(request);
      const rows = database.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(user.id);
      const unread = database.prepare("SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0").get(user.id);
      sendJson(response, 200, {
        notifications: rows.map(n => ({ id: n.id, requestId: n.request_id, message: n.message, isRead: !!n.is_read, createdAt: n.created_at })),
        unreadCount: unread ? unread.count : 0,
      });
      return;
    }
    if (pathname === "/api/notifications/read" && request.method === "POST") {
      const user = requireUser(request);
      database.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0").run(user.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    /* Admin clients overview */
    if (pathname === "/api/admin/users" && request.method === "GET") {
      requireAdmin(request);
      const clients = database.prepare(`
        SELECT u.id, u.email, u.name, u.role, u.created_at,
               COUNT(r.id) AS total_requests,
               SUM(CASE WHEN r.status IN ('completed') THEN 1 ELSE 0 END) AS completed_requests,
               SUM(CASE WHEN r.status IN ('pending', 'prepared', 'processing') THEN 1 ELSE 0 END) AS active_requests
        FROM users u
        LEFT JOIN requests r ON r.user_id = u.id
        WHERE u.role = 'client'
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `).all();
      sendJson(response, 200, {
        clients: clients.map(c => ({
          id: c.id,
          email: c.email,
          name: c.name,
          createdAt: c.created_at,
          totalRequests: Number(c.total_requests || 0),
          completedRequests: Number(c.completed_requests || 0),
          activeRequests: Number(c.active_requests || 0),
        })),
      });
      return;
    }

    /* File upload serving (Admin ou propriétaire de la demande) */
    const uploadMatch = pathname.match(/^\/api\/uploads\/([a-f0-9]+\.[a-z]+)$/);
    if (uploadMatch && request.method === "GET") {
      const user = requireUser(request);
      const filename = uploadMatch[1];
      if (user.role !== "admin") {
        const ownerRow = database.prepare("SELECT id FROM requests WHERE user_id = ? AND id_document = ?").get(user.id, filename);
        if (!ownerRow) throw httpError(403, "Accès refusé au document demandé.");
      }
      const filePath = resolve(uploadsPath, filename);
      if (!existsSync(filePath)) throw httpError(404, "Fichier introuvable.");
      const data = readFileSync(filePath);
      const ext = filename.split(".").pop();
      const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };
      response.writeHead(200, {
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Content-Length": data.length,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
      });
      response.end(data);
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
