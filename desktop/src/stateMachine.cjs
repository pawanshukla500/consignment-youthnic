const BOX_STATES = Object.freeze({
  OPEN: 'OPEN',
  CLOSED_LOCAL: 'CLOSED_LOCAL',
  QUEUED: 'QUEUED',
  DATA_SYNCING: 'DATA_SYNCING',
  DATA_SYNCED: 'DATA_SYNCED',
  VIDEO_QUEUED: 'VIDEO_QUEUED',
  VIDEO_UPLOADING: 'VIDEO_UPLOADING',
  VIDEO_VERIFYING: 'VIDEO_VERIFYING',
  SYNCED: 'SYNCED',
  RETRY: 'RETRY',
  FAILED: 'FAILED',
});

const TRANSITIONS = {
  OPEN: new Set(['CLOSED_LOCAL', 'RETRY']),
  CLOSED_LOCAL: new Set(['QUEUED', 'DATA_SYNCING', 'RETRY', 'FAILED']),
  QUEUED: new Set(['DATA_SYNCING', 'VIDEO_QUEUED', 'RETRY', 'FAILED']),
  DATA_SYNCING: new Set(['DATA_SYNCED', 'RETRY', 'FAILED']),
  DATA_SYNCED: new Set(['VIDEO_QUEUED', 'SYNCED', 'RETRY', 'FAILED']),
  VIDEO_QUEUED: new Set(['VIDEO_UPLOADING', 'RETRY', 'FAILED']),
  VIDEO_UPLOADING: new Set(['VIDEO_VERIFYING', 'RETRY', 'FAILED']),
  VIDEO_VERIFYING: new Set(['SYNCED', 'RETRY', 'FAILED']),
  RETRY: new Set(['QUEUED', 'DATA_SYNCING', 'VIDEO_QUEUED', 'VIDEO_UPLOADING', 'FAILED']),
  FAILED: new Set(['RETRY']),
  SYNCED: new Set(),
};

function transitionState(from, to) {
  if (from === to) return to;
  if (!TRANSITIONS[from]?.has(to)) {
    const error = new Error(`Invalid desktop box state transition: ${from} -> ${to}`);
    error.code = 'INVALID_BOX_STATE_TRANSITION';
    throw error;
  }
  return to;
}

function summarizeBoxes(boxes = []) {
  const rows = Array.isArray(boxes) ? boxes : [];
  const localSafe = rows.filter((box) => [BOX_STATES.CLOSED_LOCAL, BOX_STATES.QUEUED, BOX_STATES.DATA_SYNCING, BOX_STATES.DATA_SYNCED, BOX_STATES.VIDEO_QUEUED, BOX_STATES.VIDEO_UPLOADING, BOX_STATES.VIDEO_VERIFYING, BOX_STATES.SYNCED].includes(box.state)).length;
  const cloudSynced = rows.filter((box) => box.state === BOX_STATES.SYNCED).length;
  const pendingData = rows.filter((box) => ![BOX_STATES.DATA_SYNCED, BOX_STATES.SYNCED].includes(box.state)).length;
  const pendingVideos = rows.filter((box) => box.video_state && box.video_state !== BOX_STATES.SYNCED).length;
  return { localSafe, cloudSynced, pendingData, pendingVideos };
}

module.exports = { BOX_STATES, TRANSITIONS, transitionState, summarizeBoxes };
