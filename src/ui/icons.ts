/**
 * The toolbar's icons, as inline SVG.
 *
 * They are drawn rather than typed for two reasons. Emoji render differently
 * on every platform -- and several of the glyphs this toolbar needs (a road, a
 * zoning square, a bulldozer) have no emoji at all -- so a text toolbar ends up
 * a mix of pictures, kanji and arrows that never lines up. Drawn paths also
 * take `currentColor`, which is what lets a button light up when its tool is
 * active without maintaining a second set of "selected" images.
 *
 * Everything is a 24×24 box with a 1.8 stroke, so the icons look like one
 * family at the 18px the toolbar draws them at.
 */

const ICONS = {
  // --- Tools ---------------------------------------------------------------
  select:
    '<path fill="currentColor" stroke="none" d="M6 3l0 17 4.4-4.4 2.8 5.6 2.6-1.3-2.8-5.5 6-0.4z"/>',
  road:
    '<path d="M5 3v18M19 3v18"/><path d="M12 4v3.4M12 10.3v3.4M12 16.6v3.4"/>',
  rail:
    '<path d="M9 3v18M15 3v18"/><path d="M5.5 7h13M5.5 12h13M5.5 17h13"/>',
  // A deck on piers, with the ground line under it: the same road, carried.
  elevatedRoad:
    '<path d="M2.5 9.5h19"/><path d="M6 9.5v8M18 9.5v8"/><path d="M2.5 20.5h19"/>'
    + '<path d="M2.5 6.5h19"/><path d="M12 6.5v3"/>',
  elevatedRail:
    '<path d="M2.5 10.5h19"/><path d="M6 10.5v7M18 10.5v7"/><path d="M2.5 20.5h19"/>'
    + '<path d="M8 3.5v6M16 3.5v6"/><path d="M5 5.5h14M5 8h14"/>',
  station:
    '<rect x="5" y="3.5" width="14" height="13" rx="2.5"/><path d="M5 9.8h14"/>'
    + '<path d="M8.6 13.2h1.2M14.2 13.2h1.2"/><path d="M8.5 16.5 6.5 20.5M15.5 16.5l2 4"/>'
    + '<path d="M3.5 20.5h17"/>',
  line:
    '<path d="M6.6 17.4 12 12l5.4-5.4"/><circle cx="4.8" cy="19.2" r="1.9" fill="currentColor" stroke="none"/>'
    + '<circle cx="19.2" cy="4.8" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9"/>',
  powerPlant:
    '<path d="M3.5 21h17"/><path d="M4.5 21v-9l5 2.6V12l5 2.6V21"/><path d="M16 21V6.5h4.5V21"/>'
    + '<path d="M18.9 9.5 17.3 12.7h2.4L18.1 15.9"/>',
  busStop:
    '<path d="M3.5 20.5h17"/><path d="M12 20.5V9"/><rect x="5.5" y="3.5" width="13" height="6" rx="1.5"/>'
    + '<path d="M8.5 6.5h7"/>',
  busLine:
    '<rect x="4" y="4.5" width="16" height="11" rx="2"/><path d="M4 10h16"/>'
    + '<path d="M7.5 13h2M14.5 13h2"/><circle cx="8" cy="18.5" r="1.6"/><circle cx="16" cy="18.5" r="1.6"/>',
  school:
    '<path d="M12 3 21 7.5 12 12 3 7.5z"/><path d="M6.5 10v6.5c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3V10"/>'
    + '<path d="M21 7.5v5"/>',
  fireStation:
    '<path d="M3.5 20.5h17"/><path d="M5 20.5V9.5h14v11"/><path d="M5 9.5 12 4l7 5.5"/>'
    + '<path d="M12 18.5c-1.8 0-3-1.2-3-2.9 0-2 2-2.4 2-4.6 1.6.8 4 2.6 4 4.6 0 1.7-1.2 2.9-3 2.9z"/>',
  policeStation:
    '<path d="M12 3.2 19.5 6v6c0 4-3.2 7.2-7.5 8.8C7.7 19.2 4.5 16 4.5 12V6z"/>'
    + '<path d="M12 8.2 13.2 11h2.9l-2.4 1.9.9 2.9-2.6-1.8-2.6 1.8.9-2.9L7.9 11h2.9z"/>',
  bulldoze:
    '<path d="M4 7h16"/><path d="M9.8 7V4.5h4.4V7"/><path d="M6.6 7l1 13h8.8l1-13"/>',

  // --- Zoning --------------------------------------------------------------
  zoneHouse:
    '<path d="M3.5 11.8 12 5l8.5 6.8"/><path d="M6.2 9.9V20.5h11.6V9.9"/><path d="M10.2 20.5V15.5h3.6v5"/>',
  zoneApartment:
    '<path d="M4.5 20.5V5.5h6.5v15M11 20.5V10h8.5v10.5"/>'
    + '<path d="M6.5 8.5h2.5M6.5 12h2.5M6.5 15.5h2.5M13.5 13h2M17 13h1.5M13.5 16.5h2M17 16.5h1.5"/>',
  zoneShop:
    '<path d="M4.5 9.5h15v11h-15z"/><path d="M4.5 9.5 6.5 5h11l2 4.5"/><path d="M9.5 20.5v-6h5v6"/>',
  zoneFactory:
    '<path d="M3 20.5V11l6 3.4V11l6 3.4v6.1z"/><path d="M17.5 20.5V7h3.5v13.5"/>'
    + '<path d="M19.3 4.6c0-1.4-1.8-1.4-1.8-2.8"/>',
  zoneOffice:
    '<path d="M6 20.5V3.5h12v17z"/><path d="M9 7h2M13 7h2M9 10.5h2M13 10.5h2M9 14h2M13 14h2"/>'
    + '<path d="M10.5 20.5v-3.5h3v3.5"/>',
  zoneFarm:
    '<path d="M12 20.5v-7.8"/><path d="M12 14.6c-4 0-6-2.4-6-6 3.6 0 6 2 6 6z"/>'
    + '<path d="M12 15.6c0-3.6 2.4-5.6 5.8-5.6 0 3.2-2.2 5.6-5.8 5.6z"/><path d="M3.5 20.5h17"/>',
  zoneForest:
    '<path d="M12 3 7 11.2h3L6 17.4h12L14 11.2h3z"/><path d="M12 17.4v4"/>',
  zoneFish:
    '<path d="M3.5 12c3.4-4.4 9.4-4.4 12.8 0-3.4 4.4-9.4 4.4-12.8 0z"/><path d="M16.3 12 20.5 8.4v7.2z"/>'
    + '<circle cx="7.6" cy="11" r="0.9" fill="currentColor" stroke="none"/>',
  zoneMine:
    '<path d="M12 21 3.4 9.8 7.2 3.6h9.6l3.8 6.2z"/><path d="M3.4 9.8h17.2"/>'
    + '<path d="M8.6 9.8 12 21l3.4-11.2"/>',

  // --- Views ---------------------------------------------------------------
  viewZones:
    '<path d="M3.5 5.5h17v13h-17z"/><path d="M9.2 5.5v13M14.8 5.5v13M3.5 12h17"/>',
  viewIssues:
    '<path d="M12 4.5 20.5 19.5h-17z"/><path d="M12 10v4.4"/>'
    + '<circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/>',
  overlayTraffic:
    '<path d="M4 16v-2.5L6 9h12l2 4.5V16z"/><path d="M4 13.5h16"/>'
    + '<circle cx="7.6" cy="18.4" r="1.5"/><circle cx="16.4" cy="18.4" r="1.5"/>',
  overlayPower:
    '<path fill="currentColor" stroke="none" d="M13.6 2 6 13.6h4.4L9.2 22 18 10.4h-4.6z"/>',
  // Contours: the one drawing that says "height" without needing a legend.
  overlayHeight:
    '<path d="M2.5 17.5c4-5 7-5 10.5-1s6 3.5 8.5-1.5"/>'
    + '<path d="M2.5 12.5c4-5 7-5 10.5-1s6 3.5 8.5-1.5"/>'
    + '<path d="M6 7.5c2.5-2.5 5-2.5 7 0s4 2.5 6 0"/>',
  overlayCrime:
    '<path d="M12 3.2 19.5 6v6c0 4-3.2 7.2-7.5 8.8C7.7 19.2 4.5 16 4.5 12V6z"/>'
    + '<path d="M9.4 11.6a2.6 2.6 0 0 1 5.2 0"/><path d="M12 14.2v2"/>',
  overlayServices:
    '<path d="M3.5 5.5h17v13h-17z"/><path d="M12 8.5v7M8.5 12h7"/>',
  // A city hall rather than a school: this window is the school, the fire
  // brigade and the police together, and reusing the school's own icon for it
  // made the two buttons on the bar impossible to tell apart.
  winServices:
    '<path d="M3.5 20.5h17"/><path d="M5.5 20.5V10.5h13v10"/><path d="M4 10.5 12 6l8 4.5"/>'
    + '<path d="M12 6V2.8"/><path d="M12 3.2h4.5l-1.2 1.3 1.2 1.3H12"/>'
    + '<path d="M9.5 20.5v-4.5h5v4.5"/>',
  overlayNoise:
    '<path d="M4.5 14.5v-5H8l4.5-4v13L8 14.5z"/><path d="M15.8 9.4a4 4 0 0 1 0 5.2M18.4 7a7.6 7.6 0 0 1 0 10"/>',
  overlayLandValue:
    '<path d="M7 5.5 12 11.6 17 5.5"/><path d="M12 11.6v7.9"/><path d="M8 13.6h8M8 16.6h8"/>',

  // --- Windows -------------------------------------------------------------
  winInspector: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.5 20.5"/>',
  winWarnings:
    '<path d="M6 17v-6.6a6 6 0 0 1 12 0V17l1.6 2.6H4.4z"/><path d="M10 20.4a2.2 2.2 0 0 0 4 0"/>',
  winPower:
    '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3.2a6 6 0 0 1-12 0z"/><path d="M12 17.2V21"/>',
  winBudget:
    '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.7"/>'
    + '<path d="M6 10v4M18 10v4"/>',
  winStats: '<path d="M3.5 20.5h17"/><path d="M7 20.5V11.5M12 20.5V4.5M17 20.5V8.5"/>',
  randomCitizen:
    '<circle cx="10" cy="7.6" r="3.6"/><path d="M3.8 20.5a6.2 6.2 0 0 1 12.4 0"/>'
    + '<path d="M16.5 5.5h4v4"/><path d="M20.5 5.5 16.8 9.2"/>',

  // --- System --------------------------------------------------------------
  save:
    '<path d="M4.5 4.5h11l4 4v11h-15z"/><path d="M8 4.5v5h7v-5"/><path d="M7.5 19.5v-6h9v6"/>',
  load: '<path d="M12 3.5v10.5"/><path d="M8 10.2 12 14.2l4-4"/><path d="M4.5 19.5h15"/>',
  pause: '<path d="M9.5 5v14M14.5 5v14"/>',
  collapse: '<path d="M5 12h14"/>',
  expand: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6 18 18M18 6 6 18"/>',
  help:
    '<circle cx="12" cy="12" r="8.6"/><path d="M9.5 9.4a2.6 2.6 0 1 1 4.6 2.1c-1.1 1-1.9 1.6-1.9 2.9"/>'
    + '<circle cx="12" cy="17.4" r="0.9" fill="currentColor" stroke="none"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The markup for one icon, ready to drop into a button. */
export function iconMarkup(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}
