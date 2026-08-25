-- Drop existing if re-running
DROP TABLE IF EXISTS whatsapp_notification_outbox CASCADE;

-- Create Outbox table for WhatsApp operations notification layer
CREATE TABLE whatsapp_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_id text,
  event_type text NOT NULL,
  dedupe_key text UNIQUE NOT NULL,
  group_id text NOT NULL,
  message_text text,
  attachments jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending', -- pending, processing, sent, failed
  attempt_count int DEFAULT 0,
  max_attempts int DEFAULT 5,
  next_attempt_at timestamptz DEFAULT now(),
  openwa_message_id text,
  last_error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  sent_at timestamptz
);

-- Index for the processor to quickly find pending/due items
CREATE INDEX idx_whatsapp_outbox_pending ON whatsapp_notification_outbox(status, next_attempt_at) 
WHERE status IN ('pending', 'processing', 'failed');
CREATE INDEX idx_whatsapp_outbox_created_at ON whatsapp_notification_outbox(created_at);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_whatsapp_outbox_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trg_whatsapp_outbox_updated_at
    BEFORE UPDATE ON whatsapp_notification_outbox
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_outbox_updated_at();

-- Add to publication for realtime (if ever needed on frontend)
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_notification_outbox;
