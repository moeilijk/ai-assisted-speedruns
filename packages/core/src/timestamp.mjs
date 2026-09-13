// Local timestamps with an explicit UTC offset, e.g. T17:00:38.361-07:00.
// Derived from cozyblaze/portal-agent tools/pacific-time.mjs (MIT, see ../NOTICE);
// the time zone is configurable instead of fixed to America/Los_Angeles.

const formatters = new Map();

export function defaultTimeZone() {
  return process.env.AAS_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * @param {number | string | Date} value  anything Date accepts
 * @param {string} [timeZone]  IANA zone; defaults to AAS_TIME_ZONE or the system zone
 * @returns {string} ISO 8601 local time with offset; "Z" offsets are written as +00:00
 */
export function localTimestamp(value, timeZone = defaultTimeZone()) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  let offset = parts.timeZoneName.replace("GMT", "");
  if (offset === "") offset = "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}
