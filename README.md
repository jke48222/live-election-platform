# NSBE UGA — Live Election Platform

Real-time, presenter-paced election system for the UGA Chapter of the National Society of Black Engineers. Supports 60-80 concurrent voters across 14 parliamentary roles and 39 candidates.

## Architecture

- **Frontend**: Next.js 14 (App Router) + Tailwind CSS (UGA brand)
- **Backend**: Supabase (PostgreSQL + Realtime WebSocket Broadcast)
- **Identity**: Composite browser fingerprinting (Canvas + AudioContext + System) → SHA-256 device hash
- **Deploy**: Vercel

## Quick Start

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. In the SQL Editor, paste and execute the contents of `lib/schema.sql`. This creates all four tables (`election_state`, `roles`, `candidates`, `votes`) with RLS policies.
3. Copy your **Project URL**, **anon key**, and **service_role key** from Settings → API.

### 2. Configure Environment

```bash
cp .env.local.example .env.local
```

Fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NEXT_PUBLIC_ROOM_PIN=1975
ADMIN_PASSWORD=your_secure_password
```

### 3. Install & Run

```bash
npm install
npm run dev
```

- **Voter app**: `http://localhost:3000` — enter the room PIN to join
- **Admin dashboard**: `http://localhost:3000/admin` — log in with admin password

### 4. Seed the Election

From the admin dashboard, click **"Seed Database"** to populate all 14 roles and 39 candidates per the NSBE UGA chapter slate.

### 5. Deploy to Vercel

```bash
npx vercel --prod
```

Set the same environment variables in Vercel's project settings.

## Election Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   WAITING    │────▶│   VOTING    │────▶│   LOCKED    │
│ (pre-poll)   │     │ (countdown) │     │  (results)  │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                                       │
       │           Finalize & Next             │
       └───────────────────────────────────────┘
```

1. **Pre-Poll**: Admin reviews candidate checklist, toggles off winners from prior roles, adds floor nominations.
2. **Launch**: Admin sets timer duration and launches. All 80 phones instantly render the ballot via WebSocket broadcast.
3. **Voting**: Server-synced countdown. Votes submitted with 0-400ms random jitter to prevent stampeding herd.
4. **Lock**: Timer expires or admin locks early. All devices show "Voting Closed."
5. **Results**: Admin sees bar charts, total votes, tie detection. Can clear & restart (runoff) or finalize & advance.

## Security Model

| Layer | Mechanism | Protects Against |
|-------|-----------|-----------------|
| Client | LocalStorage tracking | Casual re-votes |
| Client | SHA-256 device fingerprint | Incognito/VPN bypass |
| Server | `UNIQUE(role_id, device_hash)` constraint | All duplicate votes |
| Server | RLS policies | Vote scraping, state tampering |
| Server | Silent error catching (SQLSTATE 23505) | Attack feedback loops |

## Key PRD Sections Implemented

- **§2.2**: Sequential role hierarchy with dual-office exclusion toggles
- **§2.3**: Tie-breaker clear & restart with WebSocket purge event; floor nominations
- **§3.2**: Composite browser fingerprinting (Canvas + Audio + System → SHA-256)
- **§3.3**: Database-level UNIQUE constraint with silent failure
- **§4.1**: Randomized network jitter (0-400ms) for stampeding herd mitigation
- **§4.2**: Supabase Broadcast API (bypasses WAL for sub-100ms latency)
- **§4.3**: Absolute temporal synchronization via `poll_expires_at` UTC timestamp
- **§5.1-5.2**: Web Worker heartbeat, `visibilitychange` reconnection, REST fail-safe
- **§6.1**: UGA color palette with WCAG AA contrast compliance
- **§6.2**: 48dp minimum touch targets with 8px spacing
- **§6.3**: `role="timer"` with milestone screen reader announcements (60s, 30s, 10s)
- **§7.1**: Progressive disclosure admin UI (pre-poll → telemetry → results)
- **§7.2**: Emergency "Lock Early" override
- **§8.1-8.3**: Full DDL schema with RLS policies

## File Structure

```
nsbe-election/
├── app/
│   ├── layout.js          # Root layout + metadata
│   ├── globals.css         # Tailwind + UGA brand styles
│   ├── page.js             # Voter page (PIN → ballot → vote)
│   ├── admin/
│   │   └── page.js         # Admin dashboard
│   └── api/
│       ├── state/route.js  # Election state machine (launch/lock/finalize/clear)
│       ├── vote/route.js   # Vote counts (admin GET)
│       ├── candidates/route.js  # CRUD candidates
│       └── seed/route.js   # Database seeding
├── lib/
│   ├── supabase.js         # Client singletons (browser + admin)
│   ├── fingerprint.js      # Composite SHA-256 device hash
│   ├── seed-data.js        # 14 roles + 39 candidates
│   └── schema.sql          # Full DDL + RLS policies
├── tailwind.config.js
├── next.config.js
└── package.json
```
