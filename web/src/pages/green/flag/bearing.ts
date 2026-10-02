/**
 * Which way the back camera looks (SPEC 22), from the phone's orientation and
 * never from the GPS course. Pure functions, degrees clockwise from north.
 *
 * The W3C DeviceOrientation angles are intrinsic Z-X'-Y'' rotations: the
 * device frame (x right, y up the screen, z out of the screen) maps to the
 * earth frame (x east, y north, z up) by R = Rz(alpha) Rx(beta) Ry(gamma).
 * The back camera looks along the device's -z axis, so its bearing is the
 * horizontal direction of R (0, 0, -1). That axis does not move when the
 * screen rotates, so portrait, landscape and any tilt need no special case.
 * Only when the camera points almost straight down (phone flat, nothing
 * ahead to look at) does the bearing fall back to the top of the screen,
 * which does depend on `screen.orientation.angle`.
 */

const RAD = Math.PI / 180;

/** Within this angle of straight down the camera axis says nothing about "ahead". */
export const FLAT_DEG = 20;

/** A degree value in [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** R = Rz(alpha) Rx(beta) Ry(gamma) applied to a device-frame vector: [east, north, up]. */
const rotate = (alpha: number, beta: number, gamma: number, v: readonly [number, number, number]): [number, number, number] => {
  const [ca, sa] = [Math.cos(alpha * RAD), Math.sin(alpha * RAD)];
  const [cb, sb] = [Math.cos(beta * RAD), Math.sin(beta * RAD)];
  const [cg, sg] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)];
  // Ry(gamma)
  const x1 = cg * v[0] + sg * v[2];
  const y1 = v[1];
  const z1 = -sg * v[0] + cg * v[2];
  // Rx(beta)
  const x2 = x1;
  const y2 = cb * y1 - sb * z1;
  const z2 = sb * y1 + cb * z1;
  // Rz(alpha)
  return [ca * x2 - sa * y2, sa * x2 + ca * y2, z2];
};

/**
 * Compass bearing of the back camera for an absolute orientation reading
 * (alpha referenced to north). `screenAngle` is `screen.orientation.angle`,
 * used only for the flat fallback. Null when an angle is missing.
 */
export const cameraBearing = (alpha: number | null, beta: number | null, gamma: number | null, screenAngle = 0): number | null => {
  if (alpha === null || beta === null || gamma === null || ![alpha, beta, gamma].every(Number.isFinite)) return null;
  const [e, n] = rotate(alpha, beta, gamma, [0, 0, -1]);
  if (Math.hypot(e, n) >= Math.sin(FLAT_DEG * RAD)) return norm360(Math.atan2(e, n) / RAD);
  // Flat: the top of the screen as the user holds it. Turning the screen by `screenAngle`
  // (counter-clockwise as seen by the user) makes "up" the device's cos(a) y + sin(a) x.
  const a = (Number.isFinite(screenAngle) ? screenAngle : 0) * RAD;
  const [ue, un] = rotate(alpha, beta, gamma, [Math.sin(a), Math.cos(a), 0]);
  return norm360(Math.atan2(ue, un) / RAD);
};

/** Circular mean of headings in degrees (so 359 and 1 average to 0). Null for none. */
export const circularMean = (degs: readonly number[]): number | null => {
  if (degs.length === 0) return null;
  let s = 0;
  let c = 0;
  for (const d of degs) {
    s += Math.sin(d * RAD);
    c += Math.cos(d * RAD);
  }
  if (Math.hypot(s, c) < 1e-9) return norm360(degs[degs.length - 1]!);
  return norm360(Math.atan2(s, c) / RAD);
};
