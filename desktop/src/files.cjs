const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function safePart(value) {
  const text = String(value || '');
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/.test(text)) throw new Error('Invalid local storage identifier');
  return text;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  throw new TypeError('Binary file data must be an ArrayBuffer or Uint8Array');
}

class LocalFiles {
  constructor(root, { logger } = {}) {
    this.root = root;
    this.logger = logger;
    this.handles = new Map();
    this.writeChains = new Map();
    this.sessions = new Map();
    this.writeErrors = new Map();
  }

  async ensureRoot() {
    await Promise.all([
      fsp.mkdir(this.root, { recursive: true }),
      fsp.mkdir(path.join(this.root, 'database'), { recursive: true }),
      fsp.mkdir(path.join(this.root, 'consignments'), { recursive: true }),
    ]);
    return this.root;
  }

  async ensureConsignmentDirs(consignmentId) {
    const base = path.join(this.root, 'consignments', safePart(consignmentId));
    await Promise.all([
      fsp.mkdir(path.join(base, 'videos'), { recursive: true }),
      fsp.mkdir(path.join(base, 'videos', 'recovery'), { recursive: true }),
      fsp.mkdir(path.join(base, 'proofs'), { recursive: true }),
    ]);
    return base;
  }

  async startVideo({ videoId = crypto.randomUUID(), consignmentId, boxNo, fileName = null }) {
    await this.ensureRoot();
    const health = await this.diskHealth();
    if (health.critical || health.unavailable) throw new Error('Cannot safely start recording: free disk space is insufficient or unavailable');
    if (this.handles.has(videoId)) throw new Error('Recording is already open');
    const base = await this.ensureConsignmentDirs(consignmentId);
    const ext = String(fileName || '').toLowerCase().endsWith('.mp4') ? '.mp4' : '.webm';
    const localPath = path.join(base, 'videos', `${safePart(videoId)}${ext}`);
    const recoveryPath = path.join(base, 'videos', 'recovery', `${safePart(videoId)}.part`);
    // A new MediaRecorder stream must not append another container header to
    // an interrupted recording. Keep old evidence and use a fresh recording ID.
    const manifest = { videoId, consignmentId, boxNo: String(boxNo), localPath, recoveryPath, mimeType: ext === '.mp4' ? 'video/mp4' : 'video/webm' };
    await this.writeDurable(`${recoveryPath}.json`, Buffer.from(JSON.stringify(manifest)), 'wx');
    const handle = await fsp.open(recoveryPath, 'wx');
    this.handles.set(videoId, handle);
    this.sessions.set(videoId, manifest);
    this.writeChains.set(videoId, Promise.resolve());
    this.logger?.info('video.started', { videoId, consignmentId, boxNo });
    return manifest;
  }

  async appendVideoChunk({ videoId, data }) {
    const handle = this.handles.get(videoId);
    if (!handle) throw new Error('Recording session is not open');
    const buffer = toBuffer(data);
    const previous = this.writeChains.get(videoId) || Promise.resolve();
    const next = previous.then(async () => {
      if (this.writeErrors.has(videoId)) throw this.writeErrors.get(videoId);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (!bytesWritten) throw new Error('Video write made no progress');
        offset += bytesWritten;
      }
      await handle.datasync();
    });
    this.writeChains.set(videoId, next.catch((error) => { this.writeErrors.set(videoId, error); }));
    await next;
    return { videoId, bytes: buffer.length };
  }

  async finalizeVideo({ videoId, consignmentId, boxNo, mimeType = 'video/webm' }) {
    const session = this.sessions.get(videoId);
    if (session && (session.consignmentId !== consignmentId || session.boxNo !== String(boxNo))) throw new Error('Recording belongs to a different box');
    const handle = this.handles.get(videoId);
    if (!handle) throw new Error('Recording session is not open or was already finalized');
    await (this.writeChains.get(videoId) || Promise.resolve());
    if (this.writeErrors.has(videoId)) throw new Error('A recording chunk was not saved. The partial video is preserved for recovery.');
    await handle.sync();
    await handle.close();
    this.handles.delete(videoId);
    this.writeChains.delete(videoId);
    const base = await this.ensureConsignmentDirs(consignmentId);
    const recoveryPath = path.join(base, 'videos', 'recovery', `${safePart(videoId)}.part`);
    const ext = String(mimeType).includes('mp4') ? '.mp4' : '.webm';
    const localPath = path.join(base, 'videos', `${safePart(videoId)}${ext}`);
    await fsp.rename(recoveryPath, localPath);
    const stat = await fsp.stat(localPath);
    const sha256 = await this.hashFile(localPath);
    const result = { videoId, consignmentId, boxNo: String(boxNo), localPath, sizeBytes: stat.size, sha256, mimeType };
    if (!stat.size) throw new Error('Recording contains no video data');
    await this.writeDurable(`${localPath}.json`, Buffer.from(JSON.stringify(result)));
    this.logger?.info('video.finalized', { videoId, consignmentId, boxNo, sizeBytes: stat.size });
    return result;
  }

  async writeProof({ proofId = crypto.randomUUID(), consignmentId, boxNo, data, fileName = null }) {
    const base = await this.ensureConsignmentDirs(consignmentId);
    const localPath = path.join(base, 'proofs', `${safePart(proofId)}${String(fileName || '').toLowerCase().endsWith('.png') ? '.png' : '.jpg'}`);
    const buffer = toBuffer(data);
    await this.writeDurable(localPath, buffer);
    const result = { proofId, consignmentId, boxNo: String(boxNo), localPath, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
    this.logger?.info('proof.saved', { proofId, consignmentId, boxNo, sizeBytes: buffer.length });
    return result;
  }

  async writeDurable(filePath, data, flags = 'w') {
    const handle = await fsp.open(filePath, flags, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }

  async validateEvidence(evidence, consignmentId, boxNo, kind) {
    if (!evidence || evidence.consignmentId !== consignmentId || String(evidence.boxNo) !== String(boxNo)) throw new Error('Evidence does not belong to this box');
    const base = await this.ensureConsignmentDirs(consignmentId);
    const id = safePart(kind === 'video' ? evidence.videoId : evidence.proofId);
    const ext = path.extname(evidence.localPath || '').toLowerCase();
    if (!(kind === 'video' ? ['.mp4', '.webm'] : ['.jpg', '.png']).includes(ext)) throw new Error('Invalid evidence file type');
    const expected = path.join(base, kind === 'video' ? 'videos' : 'proofs', id + ext);
    if (path.resolve(evidence.localPath || '') !== path.resolve(expected)) throw new Error('Evidence path is outside the box storage');
    const stat = await fsp.lstat(expected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size !== evidence.sizeBytes) throw new Error('Evidence is empty or changed on disk');
    return evidence;
  }

  async hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async readRange(filePath, start, end) {
    const handle = await fsp.open(filePath, 'r');
    try {
      const size = Math.max(0, end - start);
      const buffer = Buffer.allocUnsafe(size);
      const result = await handle.read(buffer, 0, size, start);
      return result.bytesRead === size ? buffer : buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  async recoverIncompleteRecordings() {
    const recoveryRoot = path.join(this.root, 'consignments');
    const found = [];
    async function walk(dir) {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.part')) {
          const stat = await fsp.stat(full).catch(() => null);
          found.push({
            path: full,
            videoId: entry.name.slice(0, -'.part'.length),
            sizeBytes: stat?.size || 0,
            resumable: false,
            requiresReview: true,
          });
        }
      }
    }
    await walk(recoveryRoot);
    if (found.length) this.logger?.warn('video.recovery_pending', { count: found.length });
    return found;
  }

  async diskHealth() {
    try {
      const stat = await fsp.statfs(this.root);
      const freeBytes = Number(stat.bavail ?? stat.bfree ?? 0) * Number(stat.bsize || 1);
      const totalBytes = Number(stat.blocks || 0) * Number(stat.bsize || 1);
      return {
        root: this.root,
        databaseRoot: path.join(this.root, 'database'),
        consignmentRoot: path.join(this.root, 'consignments'),
        freeBytes,
        totalBytes,
        low: freeBytes < 2 * 1024 * 1024 * 1024,
        critical: freeBytes < 512 * 1024 * 1024,
      };
    } catch (error) {
      this.logger?.warn('storage.health_unavailable', { message: error.message });
      return {
        root: this.root,
        databaseRoot: path.join(this.root, 'database'),
        consignmentRoot: path.join(this.root, 'consignments'),
        freeBytes: null,
        totalBytes: null,
        low: false,
        critical: false,
        unavailable: true,
      };
    }
  }
}

module.exports = { LocalFiles, toBuffer, safePart };
