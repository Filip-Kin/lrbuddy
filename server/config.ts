import pkg from "../package.json" with { type: "json" };

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env ${name}. Copy .env.example to .env and set it.`);
  }
  return v;
};

const optional = (name: string, fallback: string): string => {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
};

const publicUrl = optional("PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, "");

export const config = {
  version: pkg.version,
  port: Number(optional("PORT", "3000")),
  dataDir: optional("DATA_DIR", "./data"),
  sessionSecret: required("SESSION_SECRET"),
  adminPassword: required("ADMIN_PASSWORD"),
  publicUrl,
  secureCookie: publicUrl.startsWith("https"),
  vapidPublicKey: optional("VAPID_PUBLIC_KEY", ""),
  vapidPrivateKey: optional("VAPID_PRIVATE_KEY", ""),
  vapidSubject: optional("VAPID_SUBJECT", "mailto:me@filipkin.com"),
  /** `off` disables OSRM and always uses the nearest-neighbour fallback. */
  osrmUrl: optional("OSRM_URL", "https://router.project-osrm.org").replace(/\/+$/, ""),
  webDist: optional("WEB_DIST", new URL("../web/dist/", import.meta.url).pathname),
} as const;
