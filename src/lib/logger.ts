type LogLevel = "info" | "warn" | "error" | "debug";

function stamp() {
  return new Date().toISOString();
}

function format(scope: string, level: LogLevel, message: string, meta?: unknown) {
  const prefix = `[${stamp()}] [${scope}] [${level.toUpperCase()}] ${message}`;
  if (meta === undefined) return prefix;
  try {
    return `${prefix} ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
  } catch {
    return `${prefix} [unserializable meta]`;
  }
}

export function createLogger(scope: string) {
  return {
    info(message: string, meta?: unknown) {
      console.log(format(scope, "info", message, meta));
    },
    warn(message: string, meta?: unknown) {
      console.warn(format(scope, "warn", message, meta));
    },
    error(message: string, meta?: unknown) {
      console.error(format(scope, "error", message, meta));
    },
    debug(message: string, meta?: unknown) {
      if (process.env.LOG_LEVEL === "debug") {
        console.log(format(scope, "debug", message, meta));
      }
    },
    step(step: string, message: string, meta?: unknown) {
      console.log(format(scope, "info", `[${step}] ${message}`, meta));
    },
  };
}
