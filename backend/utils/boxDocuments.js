/**
 * Box document payloads.
 *
 * A box row is written from two places: the packing save-box transaction, and
 * the video metadata handler. The video path only *updates* video fields, but
 * `setDocument` upserts — so when a video is recorded before that box's
 * contents are saved it CREATES the box document. Identity fields therefore
 * have to be part of every such write:
 *
 *  - without `consignmentId` the row is invisible to the consignmentId lookup
 *    used by the packing report and the consignment detail endpoint, and the
 *    documents→boxes sync trigger rejects it outright (boxes.consignment_id is
 *    NOT NULL REFERENCES consignments(id), so the trigger's 'UNKNOWN' fallback
 *    raises a foreign-key violation that aborts the whole write);
 *  - without `boxNo` the box has no real box number, and anything downstream —
 *    the packing report, the Google Sheet push — has nothing to key on.
 */

function buildVideoBoxDocument({ consignmentId, boxNo, videoId, videoStatus = 'metadata_saved', at }) {
  return {
    consignmentId,
    boxNo: String(boxNo),
    videoStatus,
    videoId,
    videoUpdatedAt: at,
  };
}

/** Box documents are addressed by a deterministic id derived from the box number. */
function buildBoxId(consignmentId, boxNo) {
  return `${consignmentId}_box_${boxNo}`;
}

module.exports = { buildVideoBoxDocument, buildBoxId };
