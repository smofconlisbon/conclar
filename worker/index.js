import configData from "../src/config.json";
import { Temporal } from "@js-temporal/polyfill";

// Link-preview crawlers (Slack, Discord, WhatsApp, Mastodon...) don't run JS,
// so per-item metadata has to be injected into the SPA shell server-side.

const DATA_TTL_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION_LENGTH = 300;

let cachedData = null;
let cachedAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const shell = await env.ASSETS.fetch(new URL("/", url));

    const match = url.pathname.match(/^\/(id|people)\/([^/]+)\/?$/);
    if (!match) {
      return shell;
    }

    try {
      const data = await loadData();
      if (!data) {
        return shell;
      }
      const id = decodeURIComponent(match[2]);
      const meta =
        match[1] === "id" ? itemMeta(id, data) : personMeta(id, data);
      if (!meta) {
        return shell;
      }
      return injectMeta(shell, { ...meta, url: url.href });
    } catch (err) {
      console.error("Failed to add item metadata", err);
      return shell;
    }
  },
};

async function loadData() {
  if (cachedData && Date.now() - cachedAt < DATA_TTL_MS) {
    return cachedData;
  }

  const { COMBINED, SCHEDULE, PEOPLE } = configData.DATA_URLS ?? {};
  let program, people;
  if (COMBINED) {
    ({ program, people } = await fetchData(COMBINED));
  } else if (SCHEDULE && PEOPLE) {
    const [schedule, peopleData] = await Promise.all([
      fetchData(SCHEDULE),
      fetchData(PEOPLE),
    ]);
    program = schedule.program;
    people = peopleData.people;
  } else {
    return null;
  }

  cachedData = { program: program ?? [], people: people ?? [] };
  cachedAt = Date.now();
  return cachedData;
}

async function fetchData(dataUrl) {
  const res = await fetch(dataUrl, {
    headers: configData.FETCH_OPTIONS_FIRST?.headers,
    cf: { cacheTtl: DATA_TTL_MS / 1000, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`Fetching ${dataUrl} failed: ${res.status}`);
  }
  const parsed = await res.json();
  if (parsed.schemaVersion !== 2) {
    throw new Error("Unknown schema version: " + parsed.schemaVersion);
  }
  return { program: parsed.schedule, people: parsed.people };
}

// Mirrors ProgramData.processDateAndTime, which can't be imported because
// its module graph touches localStorage at load time.
function parseStart(item) {
  const zone = configData.TIMEZONE;
  if (!item.datetime) {
    return Temporal.ZonedDateTime.from(`${item.date}T${item.time}[${zone}]`);
  }
  const matches = item.datetime.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?(Z)?([+-]\d{2}:\d{2})?/,
  );
  if (!matches || (!matches[3] && !matches[4])) {
    return Temporal.ZonedDateTime.from(`${item.datetime}[${zone}]`);
  }
  const offset = matches[4] ?? "+00:00";
  return Temporal.ZonedDateTime.from(`${matches[1]}[${offset}]`);
}

function itemMeta(id, data) {
  const item = data.program.find((entry) => String(entry.id) === id);
  if (!item) {
    return null;
  }
  return { title: item.title, description: describeItem(item, data.people) };
}

function personMeta(id, data) {
  const person = data.people.find((entry) => String(entry.id) === id);
  if (!person) {
    return null;
  }
  let description = excerpt(htmlToText(person.bio ?? ""), MAX_DESCRIPTION_LENGTH);
  if (!description) {
    const titles = data.program
      .filter((item) => item.people?.some((p) => String(p.id) === id))
      .map((item) => item.title);
    description = excerpt(titles.join(" · "), MAX_DESCRIPTION_LENGTH);
  }
  return {
    title: personName(person),
    description,
    image: person.links?.img || person.links?.photo || person.image_256_url,
  };
}

function personName(person) {
  return Array.isArray(person.name) ? person.name.join(" ") : person.name;
}

function htmlToText(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

function describeItem(item, people) {
  const parts = [formatTime(item)];
  if (Array.isArray(item.loc) && item.loc.length) {
    parts.push(item.loc.join(", "));
  }
  const participants = describeParticipants(item, people);
  if (participants) {
    parts.push(participants);
  }
  return parts.filter(Boolean).join(" · ");
}

function formatTime(item) {
  const timeZone = configData.TIMEZONE;
  const start = parseStart(item).withTimeZone(timeZone);
  const mins = Number(item.mins) || 0;

  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(start.epochMilliseconds));

  let time = formatClock(start);
  if (mins > 0) {
    time += "–" + formatClock(start.add({ minutes: mins }));
  }
  const zone = configData.TIMEZONECODE ? " " + configData.TIMEZONECODE : "";
  return `${day}, ${time}${zone}`;
}

function formatClock(zonedTime) {
  const minutes = String(zonedTime.minute).padStart(2, "0");
  const format = configData.TIME_FORMAT ?? {};
  if (!format.DEFAULT_12HR) {
    return `${String(zonedTime.hour).padStart(2, "0")}:${minutes}`;
  }
  const hour = zonedTime.hour % 12 || 12;
  const suffix = zonedTime.hour < 12 ? format.AM ?? "AM" : format.PM ?? "PM";
  return `${hour}:${minutes}${suffix}`;
}

function describeParticipants(item, people) {
  if (!Array.isArray(item.people)) {
    return "";
  }
  const names = [];
  for (const entry of item.people) {
    const person = people.find((p) => p.id === entry.id);
    if (!person) {
      continue;
    }
    const name = personName(person);
    const isModerator =
      entry.role === "moderator" || Boolean(entry.name?.includes("(moderator)"));
    names.push({
      label: isModerator ? `${name} (moderator)` : name,
      isModerator,
      sortname: person.sortname || name,
    });
  }
  names.sort(
    (a, b) =>
      Number(b.isModerator) - Number(a.isModerator) ||
      a.sortname.localeCompare(b.sortname),
  );
  return names.map((n) => n.label).join(", ");
}

function injectMeta(response, { title, description, url, image }) {
  const siteName = configData.APP_TITLE;
  const tags = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", siteName],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["name", "twitter:card", "summary"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ...(image
      ? [
          ["property", "og:image", image],
          ["name", "twitter:image", image],
        ]
      : []),
  ]
    .map(
      ([attr, key, value]) =>
        `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`,
    )
    .join("");

  const rewritten = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(siteName ? `${title} – ${siteName}` : title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", description);
      },
    })
    .on("head", {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(response);

  const headers = new Headers(rewritten.headers);
  // The shell's ETag describes the unmodified index.html.
  headers.delete("etag");
  return new Response(rewritten.body, { status: response.status, headers });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
