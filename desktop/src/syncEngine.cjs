const fs = require('node:fs/promises');
const path = require('node:path');
const { BackendError } = require('./backendClient.cjs');

const PART_SIZE = 8 * 1024 * 1024;
// Connectivity failures must remain queued until the network returns. A
// permanently bounded retry count would make a valid local box/video look
// lost after a long outage and require manual recovery.
const MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

class SyncEngine {
  constructor({ database, files, client, logger, onStatus }) {
    this.database = database;
    this.files = files;
    this.client = client;
    this.logger = logger;
    this.onStatus = onStatus;
    this.timer = null;
    this.leaseTimer = null;
    this.running = false;
    this.online = null;
    this.lastSyncAt = null;
    this.activeLease = null;
    this.sessionEpoch = 0;
  }

  setToken(token) {
    if (this.client.token !== token) this.sessionEpoch += 1;
    this.client.setToken(token);
  }

  async setSession({ token, userId = null, user = null } = {}) {
    this.setToken(token);
    this.user = user;
    this.database.setSetting('sessionUserId', userId);
    await this.notify();
    return { ok: true };
  }

  async claimLease(payload) {
    const result = await this.client.claimLease(payload);
    this.activeLease = result.lease;
    this.database.setSetting(`lease:${payload.consignment_id}`, result.lease);
    this.database.setSetting('activeLease', this.activeLease);
    if (!this.leaseTimer) this.leaseTimer = setInterval(() => this.renewLease().catch(() => {}), 30_000);
    this.logger?.info('lease.claimed', { consignmentId: payload.consignment_id, stationId: payload.station_id });
    return result;
  }

  async renewLease() {
    if (!this.activeLease) return null;
    try {
      const result = await this.client.renewLease({
        consignment_id: this.activeLease.consignmentId,
        station_id: this.activeLease.stationId,
        lease_id: this.activeLease.leaseId,
      });
      this.logger?.info('lease.renewed', { consignmentId: this.activeLease.consignmentId });
      return result;
    } catch (error) {
      this.logger?.warn('lease.renew_failed', { message: error.message });
      throw error;
    }
  }

  async releaseLease(payload = {}) {
    const lease = payload.consignment_id ? this.database.getSetting(`lease:${payload.consignment_id}`) : this.activeLease || this.database.getSetting('activeLease');
    if (!lease) return { ok: true };
    const cid = payload.consignment_id || lease.consignmentId;
    const pending = this.database.getStatus(cid);
    if (pending.pendingJobs || pending.boxes.some((box) => box.state === 'OPEN')) throw new Error('Sync and close local work before releasing this consignment');
    const result = await this.client.releaseLease({
      consignment_id: payload.consignment_id || lease.consignmentId,
      station_id: payload.station_id || lease.stationId,
      lease_id: payload.lease_id || lease.leaseId,
      force: Boolean(payload.force),
    });
    if (this.activeLease?.consignmentId === cid) this.activeLease = null;
    this.database.setSetting(`lease:${cid}`, null);
    this.database.setSetting('activeLease', null);
    this.logger?.info('lease.released', { consignmentId: payload.consignment_id || lease.consignmentId });
    return result;
  }

  async ensureLeaseForConsignment(consignmentId) {
    const cid = String(consignmentId || '').trim();
    if (!cid) throw new Error('A consignment is required before desktop sync');
    if (this.activeLease?.consignmentId === cid) return this.activeLease;
    // Retain assignments while local work is pending. Releasing another
    // consignment here would permit a second station to change its quantities.
    const station = this.database.ensureStation();
    const result = await this.claimLease({
      consignment_id: cid,
      station_id: station.station_id,
      station_name: station.station_name,
      warehouse: station.warehouse,
    });
    return result.lease;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.process().catch((error) => this.logger?.warn('sync.process_failed', { message: error.message })), 15_000);
    this.process().catch(() => {});
  }

  stop() {
    this.sessionEpoch += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.leaseTimer = null;
  }

  async retry() {
    this.database.db.prepare(`UPDATE sync_outbox SET state = 'retry', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE state IN ('failed', 'retry')`).run(new Date().toISOString());
    return this.process();
  }

  async notify(extra = {}) {
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    const status = this.database.getStatus(null, this.user?.id || '__signed_out__');
    this.onStatus?.({
      online: this.online,
      running: this.running,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError || null,
      ...status,
      ...extra,
    });
  }

  async process() {
    if (this.running || !this.client.token) {
      await this.notify();
      return { skipped: true };
    }
    this.running = true;
    const epoch = this.sessionEpoch;
    await this.notify();
    let processed = 0;
    try {
      while (this.client.token && epoch === this.sessionEpoch) {
        const job = this.database.claimNextOutbox();
        if (!job) break;
        try {
          const snapshot = this.database.getSnapshot(job.consignment_id);
          if (snapshot?.localSnapshotUserId && snapshot.localSnapshotUserId !== this.database.getSetting('sessionUserId')) {
            throw new BackendError('Sign in as the operator who downloaded this consignment to sync its pending work.', { status: 403 });
          }
          await this.ensureLeaseForConsignment(job.consignment_id);
          if (job.kind === 'box_commit') await this.syncBox(job);
          else if (job.kind === 'video_upload') await this.syncVideo(job);
          else throw new Error(`Unsupported desktop sync job: ${job.kind}`);
          this.database.markOutboxDone(job.job_id);
          this.online = true;
          this.lastError = null;
          this.lastSyncAt = new Date().toISOString();
          processed += 1;
          this.logger?.info('sync.completed', { kind: job.kind, consignmentId: job.consignment_id });
          await this.notify();
        } catch (error) {
          this.online = Boolean(error.status && error.status < 500);
          if (error.status === 401) this.onStatus?.({ authRequired: true });
          if (error.code === 'PACKING_LEASE_NOT_ACTIVE') this.activeLease = null;
          const attempts = Number(job.attempts) || 1;
          const failed = error.status === 401 ? false : error.retryable === false || (!error.retryable && !(error instanceof TypeError));
          const delay = Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 10)));
          this.database.markOutboxRetry(job.job_id, error.message, delay, failed);
          this.logger?.warn('sync.retry', { kind: job.kind, consignmentId: job.consignment_id, attempts, message: error.message });
          await this.notify({ lastError: error.message });
          if (!error.retryable || failed) break;
        }
      }
    } finally {
      this.running = false;
      await this.notify();
    }
    return { processed };
  }

  async uploadProof(proof, payload) {
    if (!proof?.local_path) throw new Error('Weight proof file is missing locally');
    const buffer = await fs.readFile(proof.local_path);
    const extension = path.extname(proof.local_path).toLowerCase() === '.png' ? '.png' : '.jpg';
    const storagePath = `consignments/${payload.consignmentId}/documents/${proof.proof_id}${extension}`;
    const signed = await this.client.generateUploadUrl({ storagePath, mimeType: extension === '.png' ? 'image/png' : 'image/jpeg', consignmentId: payload.consignmentId });
    await this.putSigned(signed.uploadUrl, buffer, extension === '.png' ? 'image/png' : 'image/jpeg');
    const metadata = await this.client.saveMetadata({
      consignmentId: payload.consignmentId,
      type: 'weight_image',
      originalName: path.basename(proof.local_path),
      storageUrl: 'r2://uploaded',
      storagePath: signed.storagePath || storagePath,
      size: buffer.length,
      mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
      boxNo: payload.boxNo,
      clientUploadId: proof.proof_id,
      uploadQueueId: `proof:${proof.proof_id}`,
    });
    if (!metadata?.file?.id) throw new Error('Weight proof metadata was not saved');
    return { id: metadata.file.id, storagePath: signed.storagePath || storagePath };
  }

  async syncBox(job) {
    const payload = { ...(job.payload || {}) };
    if (!payload.weightImageId && payload.weightProof?.proofId) {
      const proof = this.database.db.prepare('SELECT * FROM local_weight_proofs WHERE proof_id = ?').get(payload.weightProof.proofId);
      const uploaded = await this.uploadProof(proof, payload);
      payload.weightImageId = uploaded.id;
      this.database.updateOutboxPayload(job.job_id, payload);
    }
    this.database.db.prepare(`UPDATE local_boxes SET state = 'DATA_SYNCING', updated_at = ? WHERE consignment_id = ? AND box_no = ?`).run(new Date().toISOString(), payload.consignmentId, payload.boxNo);
    await this.client.saveBox({
      consignment_id: payload.consignmentId,
      box_no: payload.boxNo,
      weight: payload.weight,
      weight_unit: payload.weightUnit,
      weight_image_id: payload.weightImageId || null,
      items: payload.items,
      operation_id: payload.operationId,
      station_id: this.database.ensureStation().station_id,
    });
    this.database.markBoxDataSynced(payload.consignmentId, payload.boxNo);
  }

  async putSigned(url, body, contentType) {
    let response;
    try {
      response = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': contentType }, signal: AbortSignal.timeout(120_000) });
    } catch (error) { throw new BackendError('Storage connection interrupted. Upload will resume.'); }
    if (!response.ok) {
      const error = new BackendError(`Storage upload failed with status ${response.status}`, { status: response.status });
      // Signed URLs expire; obtain a new URL on the next attempt.
      if ([401, 403, 404].includes(response.status)) error.retryable = true;
      throw error;
    }
    return response;
  }

  async syncVideo(job) {
    const payload = { ...(job.payload || {}) };
    const video = this.database.getVideo(payload.videoId);
    if (!video) throw new Error('Local video metadata is missing');
    const stat = await fs.stat(video.local_path);
    if (!stat.size || stat.size !== video.size_bytes) throw new Error('Local video size changed; review the preserved recording');
    const epoch = this.sessionEpoch;
    const storagePath = payload.storagePath || `consignments/${video.consignment_id}/boxes/box_${video.box_no}/video_${video.video_id}${path.extname(video.local_path) || '.webm'}`;
    let uploadId = payload.uploadId || null;
    let completedParts = Array.isArray(payload.completedParts) ? payload.completedParts : [];
    if (uploadId && !payload.multipartCompleted) {
      try {
        const listed = await this.client.listParts({ storagePath: payload.storagePath || storagePath, uploadId, consignmentId: video.consignment_id });
        completedParts = listed.parts || [];
        payload.completedParts = completedParts;
        this.database.updateOutboxPayload(job.job_id, payload);
      } catch (error) {
        if (error.code !== 'NoSuchUpload') throw error;
        // A missing upload ID means either R2 already committed the object or
        // an old incomplete upload expired. Probe before starting from scratch.
        try {
          const head = await this.client.headObject({ storagePath: payload.storagePath || storagePath, consignmentId: video.consignment_id, expectedSize: stat.size, mimeType: video.mime_type });
          if (!head.verified) throw new BackendError('Uploaded object is not verified');
          payload.multipartCompleted = true;
        } catch (headError) {
          if (headError.code !== 'STORAGE_OBJECT_MISSING') throw headError;
          uploadId = null;
          payload.uploadId = null;
          completedParts = [];
          payload.completedParts = [];
        }
        this.database.updateOutboxPayload(job.job_id, payload);
      }
    }
    if (!uploadId) {
      const created = await this.client.createMultipart({ storagePath, mimeType: video.mime_type, consignmentId: video.consignment_id });
      uploadId = created.uploadId;
      if (!uploadId) throw new Error('Could not start R2 multipart upload');
      payload.uploadId = uploadId;
      payload.storagePath = created.storagePath || storagePath;
      this.database.updateOutboxPayload(job.job_id, payload);
    }
    this.database.db.prepare(`UPDATE local_videos SET state = 'VIDEO_UPLOADING', storage_path = ?, updated_at = ? WHERE video_id = ?`).run(payload.storagePath || storagePath, new Date().toISOString(), video.video_id);
    const partCount = Math.ceil(stat.size / PART_SIZE);
    const completed = new Map(completedParts.map((part) => [Number(part.partNumber), part.etag]));
    const missingNumbers = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) if (!completed.has(partNumber)) missingNumbers.push(partNumber);
    let signedParts = [];
    if (missingNumbers.length && !payload.multipartCompleted) {
      const signed = await this.client.signParts({ storagePath: payload.storagePath || storagePath, uploadId, consignmentId: video.consignment_id, partNumbers: missingNumbers });
      signedParts = signed.parts || [];
    }
    for (const partNumber of payload.multipartCompleted ? [] : missingNumbers) {
      if (!this.client.token || epoch !== this.sessionEpoch) throw new BackendError('Upload paused because the session changed');
      const start = (partNumber - 1) * PART_SIZE;
      const buffer = await this.files.readRange(video.local_path, start, Math.min(stat.size, start + PART_SIZE));
      const signedUrl = signedParts.find((part) => Number(part.partNumber) === partNumber)?.uploadUrl;
      if (!signedUrl) throw new Error(`Missing signed URL for video part ${partNumber}`);
      const response = await this.putSigned(signedUrl, buffer, 'application/octet-stream');
      const etag = String(response.headers.get('etag') || '').replace(/"/g, '');
      if (!etag) throw new Error(`Video part ${partNumber} did not return an ETag`);
      completed.set(partNumber, etag);
      payload.completedParts = [...completed.entries()].sort(([a], [b]) => a - b).map(([number, etagValue]) => ({ partNumber: number, etag: etagValue }));
      this.database.updateOutboxPayload(job.job_id, payload);
    }
    this.database.db.prepare(`UPDATE local_videos SET state = 'VIDEO_VERIFYING', updated_at = ? WHERE video_id = ?`).run(new Date().toISOString(), video.video_id);
    if (!this.client.token || epoch !== this.sessionEpoch) throw new BackendError('Upload paused because the session changed');
    if (!payload.multipartCompleted) {
      await this.client.completeMultipart({ storagePath: payload.storagePath || storagePath, uploadId, consignmentId: video.consignment_id, parts: payload.completedParts || [], expectedSize: stat.size });
      payload.multipartCompleted = true;
      this.database.updateOutboxPayload(job.job_id, payload);
    }
    const metadata = await this.client.saveMetadata({
      consignmentId: video.consignment_id,
      type: 'video',
      originalName: path.basename(video.local_path),
      storageUrl: 'r2://uploaded',
      storagePath: payload.storagePath || storagePath,
      size: stat.size,
      mimeType: video.mime_type,
      boxNo: video.box_no,
      clientUploadId: video.video_id,
      uploadQueueId: job.job_id,
    });
    if (metadata?.verified !== true) throw new BackendError('Server has not yet verified the uploaded video');
    this.database.markVideoSynced(video.video_id, payload.storagePath || storagePath);
  }
}

module.exports = { SyncEngine, PART_SIZE, MAX_ATTEMPTS };
