const fields = ["prompt_tokens", "completion_tokens", "total_tokens"];
export function normalizeUsage(usage) {
  const normalized = {};
  for (const field of fields) normalized[field] = Number.isSafeInteger(usage?.[field]) && usage[field] >= 0 ? usage[field] : null;
  return normalized;
}

// Recompute from persisted request identities, never from the most recent sum.
// An unavailable field remains null; known_* is only an observed lower bound.
export function aggregateUsage(calls, legacyHistoryUnknown = false) {
  const usage = {
    requests: calls.length,
    main_requests: calls.filter(call => call.kind === "main").length,
    delegate_requests: calls.filter(call => call.kind === "delegate").length,
    reported_requests: calls.filter(call => fields.some(field => call.usage?.[field] !== null && call.usage?.[field] !== undefined)).length,
    legacy_history_unknown: legacyHistoryUnknown,
  };
  usage.missing_requests = usage.requests - usage.reported_requests;
  for (const field of fields) {
    const values = calls.map(call => call.usage?.[field]);
    const known = values.filter(value => Number.isSafeInteger(value) && value >= 0).reduce((sum, value) => sum + value, 0);
    usage["known_" + field] = Number.isSafeInteger(known) ? known : null;
    usage[field] = calls.length && values.every(value => Number.isSafeInteger(value) && value >= 0) && !legacyHistoryUnknown
      ? usage["known_" + field] : null;
  }
  usage.partial = legacyHistoryUnknown || fields.some(field => usage[field] === null);
  return usage;
}
