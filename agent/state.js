import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_ENTRIES = 1000;

export class State {
  constructor(path) {
    this.path = path;
    this.data = { pushed_session_ids: [], full_scan_sent_at: {} };
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.pushed_session_ids)) {
        this.data.pushed_session_ids = parsed.pushed_session_ids;
      }
      if (parsed.full_scan_sent_at && typeof parsed.full_scan_sent_at === 'object') {
        this.data.full_scan_sent_at = parsed.full_scan_sent_at;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[state] Failed to load ${this.path}: ${err.message} — starting fresh`);
      }
    }
    this._loaded = true;
  }

  has(sessionId) {
    return this.data.pushed_session_ids.includes(sessionId);
  }

  async markPushed(sessionId) {
    if (this.has(sessionId)) return;
    this.data.pushed_session_ids.push(sessionId);
    if (this.data.pushed_session_ids.length > MAX_ENTRIES) {
      this.data.pushed_session_ids.splice(0, this.data.pushed_session_ids.length - MAX_ENTRIES);
    }
    await this._persist();
  }

  hasFullScanSent(projectId) {
    return typeof this.data.full_scan_sent_at[projectId] === 'string';
  }

  async markFullScanSent(projectId) {
    this.data.full_scan_sent_at[projectId] = new Date().toISOString();
    await this._persist();
  }

  async _persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.path);
  }
}
