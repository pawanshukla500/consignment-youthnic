-- Consignment Packing App — Supabase schema
-- JSONB document store mirrors existing Firestore collection structure

CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_documents_data_gin ON documents USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_documents_consignment_id
  ON documents ((data->>'consignmentId'))
  WHERE collection IN ('skus', 'boxes', 'videos', 'documents');

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Backend uses service role / direct postgres connection; block anon/authenticated API access
CREATE POLICY "deny_anon_documents" ON documents
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- File storage is intentionally not configured in Supabase.
-- The app uses Firebase Storage for all videos and documents.
