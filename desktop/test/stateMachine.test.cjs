const test = require('node:test');
const assert = require('node:assert/strict');
const { BOX_STATES, transitionState, summarizeBoxes } = require('../src/stateMachine.cjs');

test('desktop box state machine permits local close and cloud completion', () => {
  assert.equal(transitionState(BOX_STATES.OPEN, BOX_STATES.CLOSED_LOCAL), BOX_STATES.CLOSED_LOCAL);
  assert.equal(transitionState(BOX_STATES.DATA_SYNCED, BOX_STATES.VIDEO_QUEUED), BOX_STATES.VIDEO_QUEUED);
  assert.equal(transitionState(BOX_STATES.VIDEO_VERIFYING, BOX_STATES.SYNCED), BOX_STATES.SYNCED);
  assert.throws(() => transitionState(BOX_STATES.SYNCED, BOX_STATES.OPEN), /Invalid desktop box state/);
});

test('sync summary distinguishes local-safe boxes from cloud-synced boxes', () => {
  assert.deepEqual(summarizeBoxes([
    { state: BOX_STATES.CLOSED_LOCAL, video_state: BOX_STATES.VIDEO_QUEUED },
    { state: BOX_STATES.SYNCED, video_state: BOX_STATES.SYNCED },
  ]), { localSafe: 2, cloudSynced: 1, pendingData: 1, pendingVideos: 1 });
});
