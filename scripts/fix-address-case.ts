/**
 * Title-cases addresses stored in capitals before every import went through `titleCase`
 * (tests/e2e/FOUND.md, FOUND-2: Land Bank lots kept "4136 BUCKINGHAM"). Touches `lots.address`
 * and `parcels.address` rows with no lower-case letter; mixed case is left as it is, so a second
 * run changes nothing.
 *
 *   DATA_DIR=./data bun scripts/fix-address-case.ts          # writes, prints the counts
 *   DATA_DIR=./data bun scripts/fix-address-case.ts --dry    # counts only, writes nothing
 *
 * Run it with the server stopped or between field days: open screens only show the new
 * addresses after their next refetch, since this process cannot reach the server's event bus.
 */
import { eq, isNotNull } from "drizzle-orm";
import { db, dbPath } from "../server/db/index.ts";
import { lots, parcels } from "../server/db/schema.ts";
import { titleCase } from "../server/lots-import.ts";

const dry = process.argv.includes("--dry");

const lotFixes = db
  .select({ id: lots.id, address: lots.address })
  .from(lots)
  .where(isNotNull(lots.address))
  .all()
  .flatMap((r) => (r.address !== null && titleCase(r.address) !== r.address ? [{ id: r.id, address: titleCase(r.address) }] : []));

const parcelFixes = db
  .select({ parcelId: parcels.parcelId, address: parcels.address })
  .from(parcels)
  .where(isNotNull(parcels.address))
  .all()
  .flatMap((r) => (r.address !== null && titleCase(r.address) !== r.address ? [{ parcelId: r.parcelId, address: titleCase(r.address) }] : []));

if (!dry) {
  db.transaction((tx) => {
    for (const f of lotFixes) tx.update(lots).set({ address: f.address }).where(eq(lots.id, f.id)).run();
    for (const f of parcelFixes) tx.update(parcels).set({ address: f.address }).where(eq(parcels.parcelId, f.parcelId)).run();
  });
}

console.log(`${dbPath}: ${dry ? "would fix" : "fixed"} ${lotFixes.length} lot addresses, ${parcelFixes.length} parcel addresses`);
