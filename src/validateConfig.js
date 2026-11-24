import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, "configSchema.json"), "utf-8")
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

/**
 * Validate config.json
 *
 * Runs at build / dev-server time (see vite.config.js), so an invalid
 * config.json fails the build rather than surfacing in the UI. Add further
 * config checks here as they arise; each check pushes messages onto the
 * shared errors array rather than throwing, so all problems are reported
 * in one pass.
 *
 * @param {object} configData Parsed contents of config.json.
 */
export function validateConfig(configData) {
  const errors = [];
  validateConfigSchema(configData, errors);
  try {
    validateDataSourceConfig(configData, errors);
    validateVenuesConfig(configData, errors);
  } catch {
    // configData didn't match the expected shape closely enough for these
    // checks to run; the schema errors above already explain why.
  }
  if (errors.length > 0) {
    throw new Error(
      "Invalid config.json:\n - " + errors.join("\n - ")
    );
  }
}

/**
 * Validate configData against configSchema.json, converting ajv's errors
 * into the same dotted/bracket path style used by the hand-written checks
 * below (e.g. VENUES.MAPPING[0].NAME).
 *
 * @param {object} configData Parsed contents of config.json.
 * @param {string[]} errors Accumulator for problem descriptions.
 */
function validateConfigSchema(configData, errors) {
  if (!validateSchema(configData)) {
    for (const err of validateSchema.errors) {
      errors.push(formatAjvError(err));
    }
  }
}

/**
 * @param {import("ajv").ErrorObject} err
 * @returns {string}
 */
function formatAjvError(err) {
  const path = err.instancePath
    .replace(/^\//, "")
    .replace(/\//g, ".")
    .replace(/\.(\d+)/g, "[$1]");
  const prefix = path ? `${path} ` : "config ";
  if (err.keyword === "additionalProperties") {
    const badKey = err.params.additionalProperty;
    const location = path ? `${path}.${badKey}` : badKey;
    return `${location} is not a recognized config key.`;
  }
  return `${prefix}${err.message}`;
}

/**
 * Validate that exactly one of DATA_URLS or the legacy
 * PROGRAM_DATA_URL/PEOPLE_DATA_URL pair is given, and that DATA_URLS itself
 * specifies exactly one of COMBINED or the SCHEDULE+PEOPLE pair.
 *
 * @param {object} configData Parsed contents of config.json.
 * @param {string[]} errors Accumulator for problem descriptions.
 */
function validateDataSourceConfig(configData, errors) {
  const hasLegacyUrls =
    configData.PROGRAM_DATA_URL !== undefined ||
    configData.PEOPLE_DATA_URL !== undefined;
  const hasDataUrls = configData.DATA_URLS !== undefined;

  if (hasLegacyUrls && hasDataUrls) {
    errors.push(
      "config.json cannot specify both DATA_URLS and PROGRAM_DATA_URL/PEOPLE_DATA_URL."
    );
  } else if (!hasLegacyUrls && !hasDataUrls) {
    errors.push(
      "config.json must specify either DATA_URLS or PROGRAM_DATA_URL/PEOPLE_DATA_URL."
    );
  }

  if (hasDataUrls) {
    const { COMBINED, SCHEDULE, PEOPLE } = configData.DATA_URLS;
    const hasCombined = COMBINED !== undefined;
    const hasSchedule = SCHEDULE !== undefined;
    const hasPeople = PEOPLE !== undefined;

    if (hasCombined && (hasSchedule || hasPeople)) {
      errors.push(
        "DATA_URLS cannot specify both COMBINED and SCHEDULE/PEOPLE."
      );
    }
    if (!hasCombined && hasSchedule !== hasPeople) {
      errors.push(
        "DATA_URLS must specify both SCHEDULE and PEOPLE, or COMBINED alone."
      );
    }
    if (!hasCombined && !hasSchedule && !hasPeople) {
      errors.push(
        "DATA_URLS must specify COMBINED, or both SCHEDULE and PEOPLE."
      );
    }
  }
}

/**
 * Validate the optional VENUES config block. Venues and the set objects
 * inside them share one namespace: names must be non-empty, unique, and not
 * match a LOCATIONS.MAPPING key (a matching string would be read as a
 * reference, not a location). Each LOCATIONS array must be non-empty. A
 * location may be listed directly under at most one venue, since that venue
 * is shown after the location on programme items. References must not form
 * a cycle.
 *
 * @param {object} configData Parsed contents of config.json.
 * @param {string[]} errors Accumulator for problem descriptions.
 */
function validateVenuesConfig(configData, errors) {
  if (configData.VENUES === undefined) return;

  if (!Array.isArray(configData.VENUES.MAPPING)) {
    errors.push("VENUES.MAPPING must be an array.");
    return;
  }

  const mapKeys = new Set(
    (configData.LOCATIONS?.MAPPING ?? []).map((location) => location.KEY)
  );
  // name -> { path, entries }
  const definitions = new Map();

  const define = (path, def) => {
    if (typeof def.NAME !== "string" || def.NAME.length === 0) {
      errors.push(`${path} must have a non-empty NAME.`);
      return;
    }
    if (definitions.has(def.NAME)) {
      errors.push(
        `VENUES.MAPPING contains duplicate NAME "${def.NAME}" (${definitions.get(def.NAME).path} and ${path}).`
      );
      return;
    }
    if (mapKeys.has(def.NAME)) {
      errors.push(
        `${path}.NAME "${def.NAME}" matches a location in LOCATIONS.MAPPING; venue and set names must differ from location names.`
      );
    }
    if (!Array.isArray(def.LOCATIONS) || def.LOCATIONS.length === 0) {
      errors.push(`${path} must have a non-empty LOCATIONS array.`);
      definitions.set(def.NAME, { path, entries: [] });
      return;
    }
    definitions.set(def.NAME, { path, entries: def.LOCATIONS });
  };

  for (const [index, venue] of configData.VENUES.MAPPING.entries()) {
    const path = `VENUES.MAPPING[${index}]`;
    define(path, venue);
    for (const [entryIndex, entry] of (venue.LOCATIONS ?? []).entries()) {
      if (typeof entry === "object" && entry !== null) {
        define(`${path}.LOCATIONS[${entryIndex}]`, entry);
      }
    }
  }

  const locationOwner = new Map();
  for (const venue of configData.VENUES.MAPPING) {
    for (const entry of venue.LOCATIONS ?? []) {
      if (typeof entry !== "string" || definitions.has(entry)) continue;
      const owner = locationOwner.get(entry);
      if (owner !== undefined && owner !== venue.NAME) {
        errors.push(
          `Location "${entry}" is listed directly under both "${owner}" and "${venue.NAME}" in VENUES.MAPPING.`
        );
      } else {
        locationOwner.set(entry, venue.NAME);
      }
    }
  }

  const referencesOf = (name) =>
    definitions
      .get(name)
      .entries.map((entry) => (typeof entry === "object" && entry !== null ? entry.NAME : entry))
      .filter((entryName) => definitions.has(entryName));

  const done = new Set();
  const reported = new Set();
  const visit = (name, stack) => {
    if (done.has(name)) return;
    const cycleStart = stack.indexOf(name);
    if (cycleStart !== -1) {
      const cycle = stack.slice(cycleStart);
      const key = [...cycle].sort().join("\u0000");
      if (!reported.has(key)) {
        reported.add(key);
        errors.push(
          `VENUES.MAPPING references form a cycle: ${[...cycle, name].map((n) => `"${n}"`).join(" -> ")}.`
        );
      }
      return;
    }
    stack.push(name);
    for (const ref of referencesOf(name)) {
      visit(ref, stack);
    }
    stack.pop();
    done.add(name);
  };
  for (const name of definitions.keys()) {
    visit(name, []);
  }
}
