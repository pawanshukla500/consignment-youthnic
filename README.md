# Consignment Packing Station

A modern full-stack web application for managing consignment packing operations. Built with React, Node.js, Express, and Firebase.

## Quick Start (Local Development)

```bash
# Install all dependencies
npm run install:all

# Start backend + frontend
npm run dev
```

- Backend: http://localhost:5000
- Frontend: http://localhost:5173

## Default Login

Sign in with the Firebase Auth admin account configured for your environment.

- **Email:** set via `ADMIN_EMAIL` (default bootstrap email is in `backend/.env`)
- **Password:** managed in Firebase Authentication only — never committed to source control

**Urgent:** If a previously documented shared default password was ever used in production, rotate it immediately in Firebase Console (Authentication → Users → reset password) and revoke sessions. See `docs/ADMIN_PASSWORD_ROTATION.md`.

---

## Firebase Deployment — 3 Steps

### Step 1: Get Your Firebase Config (Frontend)

Go to **Firebase Console** → Project Settings → General → Your Apps → Web App

Paste these values into `frontend/.env`:
```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=consignment-packing-app.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=consignment-packing-app
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
```

Media (videos/documents) uses Cloudflare R2 via the backend — no Firebase Storage bucket env is required on the frontend.
### Step 2: Get Your Service Account (Backend)

Go to **Firebase Console** → Project Settings → Service Accounts → "Generate new private key"

**Replace** the contents of `backend/serviceAccountKey.json` with the downloaded JSON.

The file already exists as a template — just overwrite it with your real credentials.

### Step 3: Deploy

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Build and deploy frontend
npm run deploy
```

Full details: See [`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## Project Structure

```
consignment-packing-app/
├── backend/              # Node.js + Express API
│   ├── config/firebase.js
│   ├── middleware/auth.js
│   ├── routes/
│   ├── utils/helpers.js
│   ├── server.js
│   ├── .env              # Backend env vars
│   └── serviceAccountKey.json   # REPLACE with your real JSON
├── frontend/             # React + Vite + Tailwind CSS
│   ├── src/
│   │   ├── config/firebase.js   # Frontend Firebase SDK config
│   │   ├── context/      # Auth + Toast contexts
│   │   ├── components/   # Layout, Sidebar
│   │   ├── pages/        # Dashboard, Consignments, ScanData, etc.
│   │   ├── services/api.js
│   │   └── hooks/        # useDebounce
│   ├── .env              # Frontend env vars (Firebase web config)
│   └── dist/             # Production build output
├── firebase.json         # Firebase Hosting config
├── .firebaserc           # Firebase project selector
├── package.json
├── README.md
└── DEPLOYMENT.md
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS v4, Firebase JS SDK |
| Backend | Node.js, Express, Firebase Admin SDK |
| Database | Firebase Firestore |
| Storage | Cloudflare R2 |
| Auth | JWT (Firebase Auth ready) |
| Hosting | Firebase Hosting |

## Features

- Secure login with JWT
- Consignment CRUD with SKU management
- Scan data bulk upload with CSV templates
- Inline editing of scan records
- File uploads (videos, documents) per consignment
- Productivity dashboard with audit logs
- Toast notifications
- Debounced search
- Pagination
- Responsive design

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| GET | `/api/consignments` | List consignments |
| POST | `/api/consignments` | Create consignment |
| GET | `/api/consignments/:id` | Get details |
| PUT | `/api/consignments/:id` | Update |
| DELETE | `/api/consignments/:id` | Delete |
| POST | `/api/consignments/:id/skus/:skuId/pack` | Pack SKU |
| POST | `/api/consignments/:id/boxes` | Save box |
| GET | `/api/scan-data/:consignmentId` | List scan records |
| POST | `/api/scan-data/:consignmentId/bulk` | Bulk upload |
| PUT | `/api/scan-data/:consignmentId/:recordId` | Edit record |
| DELETE | `/api/scan-data/:consignmentId/:recordId` | Delete record |
| POST | `/api/uploads` | Upload file |
| GET | `/api/templates/scan-data` | Download template |
| GET | `/api/productivity` | Stats |
| GET | `/api/productivity/audit` | Audit logs |

## License

Private — For VB Exports internal use.
