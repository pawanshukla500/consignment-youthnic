-- Create Outbox table for WhatsApp operations notification layer
CREATE TABLE whatsapp_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending, claimed, processed, failed
  claimed_at timestamptz,
  claimed_by text,
  processed_at timestamptz,
  error_message text,
  attempts int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for the processor to quickly find pending items
CREATE INDEX idx_whatsapp_outbox_pending ON whatsapp_notification_outbox(status) WHERE status IN ('pending', 'claimed');
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
