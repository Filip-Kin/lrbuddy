/** "4 min", "1 h 5 min", "now". For ages and ETAs. */
export const duration = (ms: number): string => {
  const min = Math.round(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};

export const ago = (at: number | null | undefined, now = Date.now()): string =>
  at == null ? "Never" : duration(now - at) === "now" ? "now" : `${duration(now - at)} ago`;

export const distance = (m: number): string => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** The event runs in Detroit; absolute times show Detroit local time wherever the viewer is. */
export const TIME_ZONE = "America/Detroit";

/** "2:05 PM" in Detroit. */
export const clock = (at: number): string => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });

/** "Sep 28, 2:05 PM" in Detroit, for tables. */
export const dateTime = (at: number): string =>
  new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });

export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, "")}`;
export const smsHref = (phone: string): string => `sms:${phone.replace(/[^\d+]/g, "")}`;
export const mapsDirections = (lat: number, lng: number): string => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
