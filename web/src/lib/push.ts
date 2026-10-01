import { api } from "./trpc.ts";
import { mediaMatches } from "./safe.ts";

/**
 * `install`: iPhone or iPad Safari outside a Home Screen app. WebKit only
 * delivers Web Push to an installed PWA on iOS 16.4 and later, so the
 * settings row shows "Add to Home Screen first" instead of a toggle.
 */
export type PushState = "unsupported" | "install" | "unavailable" | "denied" | "off" | "on";

const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = (): boolean =>
  mediaMatches("(display-mode: standalone)") ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Label for the Notifications row when there is no working toggle. */
export const PUSH_LABELS: Record<Exclude<PushState, "off" | "on">, string> = {
  install: "Add to Home Screen first",
  unsupported: "Not supported on this browser",
  unavailable: "Not set up on this server",
  denied: "Blocked in browser settings",
};

export const pushSupported = (): boolean =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
};

const urlBase64ToUint8Array = (b64: string): Uint8Array<ArrayBuffer> => {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export const pushState = async (): Promise<PushState> => {
  if (isIos() && !isStandalone()) return "install";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const { publicKey } = await api.shared.push.key.query();
  if (!publicKey) return "unavailable";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
};

/** Asks for permission and subscribes. Call only from a tap on the Notifications toggle. */
export const enablePush = async (): Promise<PushState> => {
  if (isIos() && !isStandalone()) return "install";
  if (!pushSupported()) return "unsupported";
  const { publicKey } = await api.shared.push.key.query();
  if (!publicKey) return "unavailable";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return "off";
  await api.shared.push.subscribe.mutate({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return "on";
};

export const disablePush = async (): Promise<PushState> => {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.shared.push.unsubscribe.mutate({ endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
};
