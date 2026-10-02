/** Credentials are never returned to the UI, used as model-generated arguments, or persisted. */
export function redactSecrets(value, secrets, depth = 0) {
  if (depth > 50) throw new Error("模型响应嵌套层数超出限制");
  const valid = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (typeof value === "string") {
    for (const secret of valid) value = value.split(secret).join("[REDACTED]");
    return value;
  }
  if (Array.isArray(value))
    return value.map((x) => redactSecrets(x, valid, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        // OpenAI function.arguments is itself serialized JSON. Canonicalize before
        // persisting, so JSON Unicode escapes cannot defer a secret until execution.
        if (k === "arguments" && typeof v === "string") {
          let parsed;
          try {
            parsed = JSON.parse(v);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (parsed !== undefined)
            v = JSON.stringify(redactSecrets(parsed, valid, depth + 1));
        }
        return [
          redactSecrets(k, valid, depth + 1),
          redactSecrets(v, valid, depth + 1),
        ];
      }),
    );
  return value;
}
