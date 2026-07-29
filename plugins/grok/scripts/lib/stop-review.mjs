const STOP_REVIEW_KEYS = ["decision", "reason"];
const PARSE_FAILURE_REASON =
  "The Grok stop review returned an unexpected answer. Run /grok:review --wait manually or disable the gate.";

export function validateStopReviewResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const extra = Object.keys(data).find((key) => !STOP_REVIEW_KEYS.includes(key));
  if (extra) {
    return `Unexpected top-level field: ${extra}.`;
  }
  for (const key of STOP_REVIEW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      return `Missing required field \`${key}\`.`;
    }
  }
  if (!new Set(["allow", "block"]).has(data.decision)) {
    return "Field `decision` must be `allow` or `block`.";
  }
  if (typeof data.reason !== "string" || data.reason.length < 1) {
    return "Field `reason` must be a non-empty string.";
  }
  return null;
}

function parseStructured(value) {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseStopReviewDecision(structuredOutput, rawOutput) {
  const structured = parseStructured(structuredOutput);
  if (validateStopReviewResult(structured) === null) {
    return {
      allow: structured.decision === "allow",
      reason: structured.reason,
      source: "structured"
    };
  }

  const text = String(rawOutput ?? (typeof structuredOutput === "string" ? structuredOutput : "")).trim();
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (first.startsWith("ALLOW:")) {
    return {
      allow: true,
      reason: first.slice("ALLOW:".length).trim() || null,
      source: "legacy"
    };
  }
  if (first.startsWith("BLOCK:")) {
    return {
      allow: false,
      reason: first.slice("BLOCK:".length).trim() || text,
      source: "legacy"
    };
  }
  return { allow: false, reason: PARSE_FAILURE_REASON, source: "invalid" };
}
