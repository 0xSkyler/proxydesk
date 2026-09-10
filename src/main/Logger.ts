import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

type LogLevel = 'info' | 'warn' | 'error';
type LogChannel = 'application' | 'proxy' | 'browser' | 'storage' | 'ipc';

const SECRET_PATTERNS: RegExp[] = [
  /\/\/[^@/\s]+@/g, // user:pass@ in URLs
  /"password"\s*:\s*"[^"]*"/gi,
  /"apiKey"\s*:\s*"[^"]*"/gi
];

function redact(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => (m.includes('@') ? '//***@' : m.split(':')[0] + '":"***"'));
  }
  return out;
}

/**
 * Structured, append-only logger writing to logs/<channel>.log under
 * userData. Never logs passwords or API keys (see redact()). Falls back to
 * console-only logging if the log directory can't be created (e.g. in unit
 * tests where `app` isn't ready), so tests never depend on filesystem state.
 */
class Logger {
  private streams: Partial<Record<LogChannel, WriteStream>> = {};
  private logsDir: string | null = null;

  private ensureDir(): string | null {
    if (this.logsDir) return this.logsDir;
    try {
      const dir = path.join(app.getPath('userData'), 'logs');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.logsDir = dir;
      return dir;
    } catch {
      return null;
    }
  }

  private streamFor(channel: LogChannel): WriteStream | null {
    if (this.streams[channel]) return this.streams[channel]!;
    const dir = this.ensureDir();
    if (!dir) return null;
    const stream = createWriteStream(path.join(dir, `${channel === 'application' ? 'application' : channel}.log`), {
      flags: 'a'
    });
    this.streams[channel] = stream;
    return stream;
  }

  private write(channel: LogChannel, level: LogLevel, message: string): void {
    const safe = redact(message);
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${channel}] ${safe}`;
    const stream = this.streamFor(channel);
    if (stream) stream.write(line + '\n');
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }

  info(channel: LogChannel, message: string): void {
    this.write(channel, 'info', message);
  }

  warn(channel: LogChannel, message: string): void {
    this.write(channel, 'warn', message);
  }

  error(channel: LogChannel, message: string): void {
    this.write(channel, 'error', message);
  }

  logsFolderPath(): string {
    return this.ensureDir() ?? path.join(app.getPath('userData'), 'logs');
  }
}

export const logger = new Logger();
