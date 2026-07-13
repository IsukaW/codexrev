/**
 * Codexrev — structured logger.
 *
 * Outputs JSON-friendly log lines to stderr by default. The level is
 * controlled by the CODEXREV_LOG_LEVEL environment variable
 * (debug | info | warn | error). Telemetry export can be wired in
 * via the telemetry module.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function currentLevel(): LogLevel {
  const raw = (process.env.CODEXREV_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel()];
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: Fields): void {
  if (!shouldLog(level)) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stderr;
  stream.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  child(component: string) {
    return {
      debug: (msg: string, fields?: Fields) => emit('debug', msg, { ...fields, component }),
      info: (msg: string, fields?: Fields) => emit('info', msg, { ...fields, component }),
      warn: (msg: string, fields?: Fields) => emit('warn', msg, { ...fields, component }),
      error: (msg: string, fields?: Fields) => emit('error', msg, { ...fields, component }),
    };
  },
};
