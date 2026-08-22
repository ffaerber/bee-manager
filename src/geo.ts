/**
 * Is this a coordinate, or is it an absence dressed as one?
 *
 * The node index reports an unknown position as `{latitude: 0, longitude: 0}`
 * rather than omitting the field. Zero is a number, so a plain type check
 * accepts it, and the result is a dot in the Gulf of Guinea — Null Island —
 * that looks exactly as real as every other dot on the map.
 *
 * That is the failure this whole map is built to avoid, and it got through
 * once: this node was published at (0, 0) with a null city, and the check that
 * should have caught it was `typeof lat === 'number'`.
 *
 * Exactly (0, 0) is in the ocean 600km off Ghana. No node is there. Treating
 * it as missing costs nothing real and removes the entire class of bug.
 */
export function plausibleCoords(lat: unknown, lon: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  // The sentinel. Not a place.
  if (lat === 0 && lon === 0) return false;
  return true;
}
