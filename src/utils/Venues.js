const VENUE_VALUE_PREFIX = "venue:";

/**
 * Whether config.json defines any venues.
 *
 * @param {object} configData Parsed config.json.
 * @returns {boolean}
 */
export function hasVenues(configData) {
  return !!(
    configData.VENUES &&
    Array.isArray(configData.VENUES.MAPPING) &&
    configData.VENUES.MAPPING.length
  );
}

/**
 * The react-select option value for an option selecting a venue or set.
 *
 * @param {string} name Venue or set name.
 * @returns {string}
 */
export function venueOptionValue(name) {
  return VENUE_VALUE_PREFIX + name;
}

/**
 * Whether a react-select option value refers to a venue or set (rather than a location).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isVenueValue(value) {
  return typeof value === "string" && value.startsWith(VENUE_VALUE_PREFIX);
}

/**
 * Extract the venue or set name from a venue option value.
 *
 * @param {string} value
 * @returns {string}
 */
export function venueNameFromValue(value) {
  return value.slice(VENUE_VALUE_PREFIX.length);
}

/**
 * Build the "All <venue>" label for a venue or set, using the configured template.
 *
 * @param {object} configData Parsed config.json.
 * @param {string} name Venue or set name.
 * @returns {string}
 */
export function allVenueLabel(configData, name) {
  const template = (configData.VENUES && configData.VENUES.ALL_LABEL) || "All @venue";
  return template.replace("@venue", name);
}

const modelCache = new WeakMap();

/**
 * Interpret VENUES.MAPPING. Venues (headings) and set objects share one
 * namespace; a string matching a name is a reference, any other string is a
 * location. Cached per configData object, since the filter calls into this
 * for every programme item.
 *
 * @param {object} configData Parsed config.json.
 * @returns {{
 *   headings: Array<{name: string, showAll: boolean, entries: Array<{kind: "set"|"location", name: string}>}>,
 *   selectable: Set<string>,
 *   owner: Map<string, string>,
 *   locationsOf: (name: string) => Set<string>,
 * }}
 */
function venueModel(configData) {
  let model = modelCache.get(configData);
  if (model) {
    return model;
  }

  const mapping = hasVenues(configData) ? configData.VENUES.MAPPING : [];
  const definitions = new Map();
  for (const venue of mapping) {
    definitions.set(venue.NAME, venue.LOCATIONS);
    for (const entry of venue.LOCATIONS) {
      if (typeof entry === "object") {
        definitions.set(entry.NAME, entry.LOCATIONS);
      }
    }
  }

  const selectable = new Set();
  const owner = new Map();
  const headings = mapping.map((venue) => {
    const showAll = venue.SHOW_ALL !== false;
    if (showAll) {
      selectable.add(venue.NAME);
    }
    const entries = venue.LOCATIONS.map((entry) => {
      const name = typeof entry === "object" ? entry.NAME : entry;
      if (typeof entry === "object" || definitions.has(name)) {
        selectable.add(name);
        return { kind: "set", name };
      }
      if (!owner.has(name)) {
        owner.set(name, venue.NAME);
      }
      return { kind: "location", name };
    });
    return { name: venue.NAME, showAll, entries };
  });

  const resolved = new Map();
  function locationsOf(name, visiting = new Set()) {
    if (resolved.has(name)) {
      return resolved.get(name);
    }
    const result = new Set();
    // Validation rejects cycles; this guard only stops a bad config hanging the page.
    if (visiting.has(name) || !definitions.has(name)) {
      return result;
    }
    visiting.add(name);
    for (const entry of definitions.get(name)) {
      const entryName = typeof entry === "object" ? entry.NAME : entry;
      if (definitions.has(entryName)) {
        for (const loc of locationsOf(entryName, visiting)) {
          result.add(loc);
        }
      } else {
        result.add(entryName);
      }
    }
    visiting.delete(name);
    resolved.set(name, result);
    return result;
  }

  model = { headings, selectable, owner, locationsOf };
  modelCache.set(configData, model);
  return model;
}

/**
 * Find the venue a location is listed directly under, if any. Locations only
 * reached through sets or references have no venue.
 *
 * @param {string} loc Location name.
 * @param {object} configData Parsed config.json.
 * @returns {?string} The venue name, or null.
 */
export function venueForLocation(loc, configData) {
  return venueModel(configData).owner.get(loc) ?? null;
}

/**
 * Build react-select options for the locations dropdown, grouped by venue in
 * VENUES.MAPPING order. Each venue group may start with an "All <venue>"
 * option, followed by its entries in config order: set objects and references
 * become options selecting a set, other strings become location options.
 * Options matching nothing in the loaded program, and groups left empty, are
 * omitted. Locations not listed directly under any venue are appended as a
 * trailing group. If no venues are configured, returns the locations
 * unchanged (a single flat list).
 *
 * @param {Array<{value: string, label: string}>} locations Locations present in the loaded program.
 * @param {object} configData Parsed config.json.
 * @returns {Array} react-select options, possibly grouped.
 */
export function buildLocationOptions(locations, configData) {
  if (!hasVenues(configData)) {
    return locations;
  }

  const model = venueModel(configData);
  const present = new Map(locations.map((loc) => [loc.value, loc]));
  const setOption = (name) => {
    for (const loc of model.locationsOf(name)) {
      if (present.has(loc)) {
        return { value: venueOptionValue(name), label: allVenueLabel(configData, name) };
      }
    }
    return null;
  };

  const groups = [];
  for (const heading of model.headings) {
    const options = [];
    if (heading.showAll) {
      const all = setOption(heading.name);
      if (all) {
        options.push(all);
      }
    }
    for (const entry of heading.entries) {
      const option = entry.kind === "set" ? setOption(entry.name) : present.get(entry.name);
      if (option) {
        options.push(option);
      }
    }
    if (options.length) {
      groups.push({ label: heading.name, options });
    }
  }

  const ungrouped = locations.filter((loc) => !model.owner.has(loc.value));
  if (ungrouped.length) {
    const label = configData.VENUES.UNGROUPED_LABEL || "Other";
    groups.push({ label, options: ungrouped });
  }
  return groups;
}

/**
 * Whether a locations-dropdown value can be selected. Location values always
 * can; a venue or set value only if the config shows it as an option somewhere.
 * Decided from config alone, so a /loc/ URL isn't pruned before the program loads.
 *
 * @param {string} value
 * @param {object} configData Parsed config.json.
 * @returns {boolean}
 */
export function isSelectableLocationValue(value, configData) {
  if (!isVenueValue(value)) {
    return true;
  }
  return venueModel(configData).selectable.has(venueNameFromValue(value));
}

/**
 * Whether a program item's location matches a selected locations-dropdown value,
 * expanding venue and set values ("venue:In-person") to all the locations they cover.
 *
 * @param {string} itemLoc A single location from a program item's loc array.
 * @param {string} selectedValue A value from the selected-locations dropdown state.
 * @param {object} configData Parsed config.json.
 * @returns {boolean}
 */
export function locationMatchesSelection(itemLoc, selectedValue, configData) {
  if (isVenueValue(selectedValue)) {
    if (!isSelectableLocationValue(selectedValue, configData)) {
      return false;
    }
    return venueModel(configData).locationsOf(venueNameFromValue(selectedValue)).has(itemLoc);
  }
  return selectedValue === itemLoc;
}

/**
 * Reconstruct the display label for a locations-dropdown value, e.g. when
 * restoring selections from the /loc/:locList URL.
 *
 * @param {string} value
 * @param {object} configData Parsed config.json.
 * @returns {string}
 */
export function labelForLocationValue(value, configData) {
  if (isVenueValue(value)) {
    return allVenueLabel(configData, venueNameFromValue(value));
  }
  return value;
}
