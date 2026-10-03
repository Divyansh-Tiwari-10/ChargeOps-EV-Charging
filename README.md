# EV ChargeOps

A database-first EV charging network mini project. The current build includes a MySQL 8.4 schema, synthetic network fixtures, transactional Express API, role-aware workflows, and a small responsive frontend.

For the complete DBMS design rationale, normalization, ER model, and report/demo guidance, see [EV_Charging_DBMS_Project_Blueprint.md](EV_Charging_DBMS_Project_Blueprint.md).

## Stack

- MySQL 8.4 with InnoDB, constraints, indexes, views, a trigger, a stored procedure, and a SQL function
- Node.js 24+, Express, mysql2, bcrypt, JWT
- Vanilla HTML/CSS/JavaScript frontend served by Express

## Start locally (Windows PowerShell)

1. Install Docker Desktop and Node.js 24 or newer.
2. Copy the sample environment file and set local secrets:

   ```powershell
   Copy-Item .env.example .env
   ```

   The defaults are for local development only. Change `DB_PASSWORD`, `JWT_SECRET`, and `MYSQL_ROOT_PASSWORD` before sharing the project or exposing a port beyond your machine.

3. Start MySQL. On a new Docker volume, the four SQL files initialize in order: schema, catalog seed, views, then routines.

   ```powershell
   docker compose up -d
   ```

4. Install backend dependencies and create repeatable synthetic demo users and charging history:

   ```powershell
   npm install
   npm run seed
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000). The API health endpoint is `/api/health`.

The seed script prints the demo password. Demo accounts are `maya@chargeops.test`, `arjun@chargeops.test`, `nila@chargeops.test`, `dev@chargeops.test`, `ops@chargeops.test`, and `admin@chargeops.test`; the seed password is `ChargeOps!2026` unless `DEMO_PASSWORD` is set before running the seed.

Docker only runs initialization scripts the first time it creates its named data volume. If you edit the schema after the database has already initialized, apply the changed SQL manually or create a fresh development database. Do not delete a volume that contains data you need.

## Implemented workflows

- Register/login with bcrypt password hashes and signed tokens
- Discover stations by city and connector; check port availability over a requested time interval
- Register an EV, reserve/cancel a port, and serialize concurrent bookings with a port-row lock
- Start a reserved session, append increasing meter readings, close the session, and create an invoice with tariff snapshot lines
- Simulate a payment and update invoice settlement state in one database transaction
- Report a port fault, remove it from availability, and resolve its ticket with a check for other active faults
- View personal booking history, technician queue, station energy analytics, and station ranking

## API map

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me` |
| Network | `GET /api/stations`, `GET /api/stations/:id`, `GET /api/ports/:id/availability` |
| EVs | `GET /api/vehicle-models`, `GET /api/vehicles`, `POST /api/vehicles` |
| Booking | `GET /api/bookings`, `POST /api/bookings`, `DELETE /api/bookings/:id` |
| Sessions | `POST /api/sessions`, `POST /api/sessions/:id/meter-readings`, `POST /api/sessions/:id/complete` |
| Payments | `POST /api/invoices/:id/payments` |
| Maintenance | `POST /api/ports/:id/maintenance`, `GET /api/maintenance`, `PATCH /api/maintenance/:id/resolve` |
| Analytics | `GET /api/analytics/energy?from=&to=`, `GET /api/analytics/station-ranking` |

## Database scripts

- `sql/schema.sql`: relational schema and constraints
- `sql/seed.sql`: roles, operator, stations, connectors, ports, links, and tariffs
- `sql/views.sql`: reporting and operational views
- `sql/routines.sql`: meter/audit triggers, booking/cancellation procedures, and session-duration function

Use UTC for stored `DATETIME(3)` values. The frontend converts browser-local booking times to ISO timestamps; the backend normalizes them before inserts. Payments are simulations and contain no real card information.

## Current implementation boundaries

This first build is focused on a coherent end-to-end student demo. It has account roles enforced by the API and database constraints, but MySQL grants for separately deployed customer accounts are not configured. Network search uses city/connector filters rather than geospatial radius. Tariff billing applies energy and session fees; idle fees, tax rules, refunds, provider integration, and real-time charger hardware are not implemented. Port utilization definitions and larger graph/path optimization can be added after the workflows are stable.
