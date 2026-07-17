# Proposal: Multi-segment box videos (requires approval)

Status: **Proposal only — not implemented.** No production schema migration in this PR.

## Problem

A single packing box recording can approach the configured upload maximum (200 MB).
If recording continues past that limit, the Blob becomes permanently unuploadable.

## Interim behavior (Phase 0.5 — shipped)

- Soft-stop recording near `softStopBytes` (190 MB) so the Blob remains uploadable.
- Evidence is never silently truncated, overwritten, or discarded.
- Operator is told to save / NEXT BOX.
- Finish still requires every required box video to be verified on the server.

## Proposed long-term model (needs explicit approval)

Keep backward compatibility with one active video per box while allowing continuation segments.

### Client (IndexedDB)

```text
videoQueue entry:
  metadata.boxNo
  metadata.segmentIndex   // 0..n
  metadata.segmentGroupId // shared across segments for one continuous pack
  status / multipart / blob (unchanged)
```

### Server (Postgres / JSONB videos)

Option A (minimal):

- Keep `videos` rows with `boxNo`
- Add nullable fields: `segmentIndex`, `segmentGroupId`, `isPrimarySegment`
- Active box video = all verified segments for the latest `segmentGroupId`
- Finish gate: every segment in the active group must be `storageVerified`

Option B (normalized):

- New table `video_segments(consignment_id, box_no, group_id, segment_index, video_id, verified)`
- Existing `videos` row remains the playback head / primary

### Finish / health

- `getMissingVerifiedVideoBoxes` must require **all segments** for each packed box.
- Playback UI concatenates or lists segments in order.

### Migration risk

- Requires a Supabase/Cockroach migration and dual-read compatibility.
- Must not break one-video-per-box historical rows (`segmentIndex` null ⇒ treat as single segment).

## Approval gate

Do **not** ship Option A/B until product/ops explicitly approve the migration and playback UX.
Until then, soft-stop + operator NEXT BOX is the safe production path.
