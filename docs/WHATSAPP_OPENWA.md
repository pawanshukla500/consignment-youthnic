# OpenWA / WhatsApp Integration

## Overview

The Consignment Packing App uses an existing OpenWA implementation (`wa.youthnic.shop`) as a **notification channel**. WhatsApp is NOT a source of truth for business logic.

### Design Principles
1. **Asynchronous Outbox Pattern**: Web requests (like consignment creation or packing confirmation) must never block waiting for WhatsApp API. Instead, we insert records into `whatsapp_notification_outbox` (`status = 'pending'`).
2. **Cloud Scheduler**: A recurring Cloud Scheduler job hits `/api/workflow/whatsapp/process-outbox` every 5 minutes. This endpoint picks up to 10 pending/failed records, attempts delivery, and logs success/failure.
3. **No Secret Leakage**: The `openwaClient.js` never leaks raw response bodies or API keys in standard errors, mitigating log pollution and security risks.
4. **Resilience**: A maximum of 5 attempts are made per outbox item. If all fail, the item is marked `failed` and can be manually retried via the Admin API.

### Environment Variables
```env
WHATSAPP_ENABLED=true
OPENWA_BASE_URL=https://wa.youthnic.shop
OPENWA_SESSION_ID=7fb5e522-6e31-424e-b596-9eb1fec10314
OPENWA_GROUP_ID=120363421287113344@g.us
OPENWA_API_KEY=********
WHATSAPP_SCHEDULER_SECRET=********
WHATSAPP_BRAND_NAME="YOUTHNIC • CONSIGNMENT OPERATIONS"
WHATSAPP_TIMEZONE=Asia/Kolkata
```

### Daily Reports
Cloud Scheduler runs two daily reports:
- **Morning Brief (8:30 AM IST)**: Summarizes active consignments, critical shipments, and overdue tasks. Attachments include an in-memory generated Excel sheet.
- **EOD Summary (8:00 PM IST)**: Summarizes all items dispatched during the day.

### Deployment Updates
The Cloud Run deployment script (`scripts/gcloud-deploy.sh`) automatically provisions and updates the Cloud Scheduler HTTP jobs with `X-Scheduler-Secret`. Secret keys like `OPENWA_API_KEY` are read securely from GitHub Actions secrets and passed as Cloud Run environment variables.
