-- M5: Enforce at most one active video per consignment+box in the mirror table.
-- Documents JSONB remains source of truth; this index protects the Realtime mirror.
-- Rollback: DROP INDEX IF EXISTS uq_videos_one_active_per_box;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'videos'
  ) THEN
    -- Prefer active=true when the column exists; otherwise unique on consignment_id+box_no.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'videos' AND column_name = 'is_active'
    ) THEN
      CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_one_active_per_box
        ON videos (consignment_id, box_no)
        WHERE is_active IS DISTINCT FROM false;
    ELSE
      -- Soft uniqueness: keep latest id by deleting duplicates is handled in app; index on pair helps lookups.
      CREATE INDEX IF NOT EXISTS idx_videos_consignment_box
        ON videos (consignment_id, box_no);
    END IF;
  END IF;
END $$;
