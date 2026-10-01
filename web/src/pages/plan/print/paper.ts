/**
 * Paper colours. A printed sheet looks the same whatever the screen scheme,
 * so these are fixed values from the light palette (SPEC 13), not CSS variables.
 */
export const INK = "#0e3038";
export const YELLOW = "#fddd08";
export const WORK = "#e5484d";
export const GREY = "#5b6b70";
export const PAPER = "#f2f3f5";
/** The company sheet's blue (SPEC 19): its areas, their names and the CC circle. */
export const BLUE = "#1f6fe5";

/**
 * Lot fills on paper. High and low are dashed at two fills; work (another
 * crew's lot) is a middle fill with a solid thin outline, so the three stay
 * apart in greyscale.
 */
export const LOT_FILL: Record<"work" | "high" | "low", number> = { high: 0.75, work: 0.5, low: 0.3 };

/**
 * Sheet and map rules. On screen a sheet is a Letter page at its real size
 * (8.5 by 11 in portrait, 11 by 8.5 in for a company map), and on paper the
 * page margin is 0 so the sheet is the page: the maps are fitted once and
 * print at the size they drew. The app shell is a fixed-height flex column
 * with a scrolling main; on paper everything has to flow.
 *
 * Orientation: the page size of the first sheet is the default `@page`, and
 * sheets of the other orientation carry a named page. Chromium starts a named
 * first sheet on a blank page of the default size, so the first sheet must
 * never be the named one.
 */
export const printCss = (firstLandscape: boolean): string => `
.lrb-paper {
  --surface: #ffffff; --surface-2: #f2f3f5; --ink: ${INK}; --line: #d1d3d4; --muted: ${GREY}; --brand: ${YELLOW}; --crew: ${WORK};
  color: ${INK};
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.lrb-pm { isolation: isolate; }
.lrb-pm.leaflet-container { background: #f2f3f5; cursor: default; }
.lrb-pm .leaflet-control-attribution { font-size: 7px; line-height: 1.3; padding: 0 3px; background: rgba(255, 255, 255, 0.85) !important; color: ${GREY}; }
.lrb-pm .leaflet-control-attribution a { color: ${GREY}; }
.lrb-pm-label {
  display: flex; align-items: center; gap: 3px; box-sizing: border-box; height: 15px; padding: 0 2px;
  font: 700 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: ${INK}; background: #ffffff; border: 1px solid ${INK}; border-radius: 3px; white-space: nowrap; overflow: hidden;
}
.lrb-pm-badge { display: inline-grid; place-items: center; width: 12px; height: 11px; font-size: 8px; border-radius: 2px; background: ${INK}; color: #ffffff; }
.lrb-pm-other { color: ${GREY}; border-color: ${GREY}; }
.lrb-pm-area { background: ${YELLOW}; }
.lrb-pm-cc { background: #000000; color: #ffffff; border-color: #000000; }
.lrb-pm-label.lrb-pm-pill {
  justify-content: center; height: 20px; padding: 0 6px; border: 1.5px solid ${BLUE}; border-radius: 9999px;
  font: 800 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: ${BLUE}; background: #ffffff;
}
.lrb-pm-ccl, .lrb-pm-ccb {
  display: grid; place-items: center; box-sizing: border-box; border-radius: 9999px; color: #ffffff;
  font: 800 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.lrb-pm-ccl { background: #000000; border: 2px solid #ffffff; box-shadow: 0 0 0 1px #000000; }
.lrb-pm-ccb { background: ${BLUE}; border: 2px solid #ffffff; box-shadow: 0 0 0 1px ${BLUE}; font-size: 16px; }
.lrb-pm-star svg, .lrb-pm-arrow svg { display: block; }
.lrb-pm-arrow span { display: block; width: 26px; height: 26px; transform-origin: 50% 50%; }
@page land { size: letter landscape; margin: 0; }
@page port { size: letter portrait; margin: 0; }
${firstLandscape ? ".lrb-sheet-port { page: port; }" : ".lrb-sheet-land { page: land; }"}
@media print {
  @page { size: letter ${firstLandscape ? "landscape" : "portrait"}; margin: 0; }
  html, body, #root { height: auto !important; overflow: visible !important; background: #ffffff !important; }
  #root .h-dvh { height: auto !important; display: block !important; }
  #root main { overflow: visible !important; }
  .lrb-sheets { display: block !important; gap: 0 !important; padding: 0 !important; margin: 0 !important; max-width: none !important; }
  .lrb-sheet { break-after: page; page-break-after: always; box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
  .lrb-sheet:last-child { break-after: auto; page-break-after: auto; }
  .lrb-print-hide { display: none !important; }
  /* A repeating table header pushes the whole table onto the next page once the
     pages change size (Chromium 120, landscape company maps then portrait sheets). */
  .lrb-sheet thead { display: table-row-group; }
}
`;
