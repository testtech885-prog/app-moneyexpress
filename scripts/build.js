"use strict";

const {
  accessSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const logoSource = resolve(root, "logo.jpg");

if (dirname(dist) !== root || dist !== resolve(root, "dist")) {
  throw new Error("Dossier dist non valide : arrêt de la génération.");
}

for (const filename of [
  ...["index.html", "styles.css", "auth.css", "branding.css", "app.js"].map((file) => resolve(root, file)),
  logoSource,
]) {
  try {
    accessSync(filename);
  } catch {
    throw new Error(`Fichier source introuvable ou illisible ; le dossier dist a été conservé : ${filename}`);
  }
}

const assets = resolve(dist, "assets");
rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

for (const filename of ["index.html", "styles.css", "auth.css", "branding.css", "app.js"]) {
  copyFileSync(resolve(root, filename), resolve(dist, filename));
}

copyFileSync(
  logoSource,
  resolve(assets, "money-express-logo.jpg"),
);
copyFileSync(
  logoSource,
  resolve(dist, "favicon.ico"),
);

writeFileSync(resolve(dist, "_redirects"), [
  "/api/* https://app-moneyexpress-1.onrender.com/api/:splat 200!",
  "/* /index.html 200",
  "",
].join("\n"), "utf8");

writeFileSync(resolve(dist, "_headers"), [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: DENY",
  "  Referrer-Policy: no-referrer",
  "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
  "  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; img-src 'self' data: https://www.google.com",
  "",
].join("\n"), "utf8");

console.info(`Application statique et logo générés dans ${dist}.`);
console.info("Les requêtes /api/* sont transmises au proxy Netlify sécurisé.");
