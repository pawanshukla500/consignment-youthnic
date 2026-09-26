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

test('a box still being packed is not reported as waiting on the network', () => {
  // Exactly the state a station reaches after closing four boxes and opening a
  // fifth: everything committed is synced, so nothing is pending.
  const summary = summarizeBoxes([
    { state: BOX_STATES.SYNCED, video_state: BOX_STATES.SYNCED },
    { state: BOX_STATES.SYNCED, video_state: BOX_STATES.SYNCED },
    { state: BOX_STATES.SYNCED, video_state: BOX_STATES.SYNCED },
    { state: BOX_STATES.SYNCED, video_state: BOX_STATES.SYNCED },
    { state: BOX_STATES.OPEN, video_state: BOX_STATES.OPEN },
  ]);
  assert.equal(summary.cloudSynced, 4);
  assert.equal(summary.localSafe, 4, 'an open box is not yet durable work');
  assert.equal(summary.pendingData, 0, 'an open box has no committed data to send');
  assert.equal(summary.pendingVideos, 0, 'an open box has no finalized video to upload');
});

test('a closed box awaiting upload is still reported as pending', () => {
  // The open box must not mask a genuinely queued neighbour.
  const summary = summarizeBoxes([
    { state: BOX_STATES.DATA_SYNCED, video_state: BOX_STATES.VIDEO_QUEUED },
    { state: BOX_STATES.RETRY, video_state: BOX_STATES.VIDEO_UPLOADING },
    { state: BOX_STATES.OPEN, video_state: BOX_STATES.OPEN },
  ]);
  assert.equal(summary.pendingData, 1, 'the RETRY box still needs its data sent');
  assert.equal(summary.pendingVideos, 2, 'both closed boxes still owe a video');
});
