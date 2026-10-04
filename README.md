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

The seed script prints the demo password. Demo accounts are `maya@chargeops.test`, `arjun@chargeops.test`, `nila@chargeops.test`, `dev@chargeops.test`, `ops@chargeops.test`, and `admin@chargeops.test`; the seed password is `ChargeOps!2026` unless `DEMO_PASSWORD` is set before running the seed. Running `npm run seed` also adds 20 clearly labeled simulated booking hubs across India. Their names, locations, and rates are for workflow demonstrations only, not real operators or current tariffs.

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
| Network | `GET /api/stations`, `GET /api/stations/:id`, `GET /api/ports/:id/availability`, `GET /api/map/geocode?q=`, `GET /api/map/public-chargers?latitude=&longitude=&radius=` |
| EVs | `GET /api/vehicle-models`, `GET /api/vehicles`, `POST /api/vehicles` |
| Booking | `GET /api/bookings`, `POST /api/bookings`, `DELETE /api/bookings/:id` |
| Sessions | `POST /api/sessions`, `POST /api/sessions/:id/meter-readings`, `POST /api/sessions/:id/complete` |
| Payments | `POST /api/invoices/:id/payments` |
| Maintenance | `POST /api/ports/:id/maintenance`, `GET /api/maintenance`, `PATCH /api/maintenance/:id/resolve` |
| Analytics | `GET /api/analytics/energy?from=&to=`, `GET /api/analytics/station-ranking` |

## India public-charger map data

The bundled BEE snapshot contains **28,526 geocoded records**, published through **26 October 2025**. This is a count of records in that dated snapshot, not a verified count of unique stations that are open today. The compressed file is `data/india-charging-stations.json.gz`; the server filters it to the requested place and radius. Nearby searches also add OpenStreetMap/Overpass charger records dynamically (including `amenity=charging_station` and `man_made=charge_point`) within the selected radius, up to 10 km. Those additional records are not included in the 28,526 count, and the app does not load every station in India into one search result.

Public station cards show a mapped station name or charging brand as the heading when available and the address beneath it; when the source only provides an address and operator, the card uses the operator as a best-effort label. Directions open Google Maps to the station coordinates and include the user's saved location when available. Review links run a Google Maps search using the station name, operator, and coordinates. They are best-effort search links: the app does not verify that Google has reviews for that exact charger, copy reviews or ratings into its own database, or guarantee review coverage. Station names, addresses, connector details, working status, and prices may be missing, stale, or incorrect. Confirm details with the charging operator before traveling.

To refresh the bundled BEE snapshot later, download the latest PDF from [BEE's public charging-station data page](https://www.beeindia.gov.in/show_content.php?lang=1&level=2&lid=67&ls_id=345) as `data/bee-public-chargers.pdf`, install Python and `pdfplumber` (`python -m pip install pdfplumber`), then run `python scripts/import-bee-pcs.py` and `python scripts/compact-bee-pcs.py` from the project folder. These steps replace the compressed JSON used by the map. The PDF and intermediate extracted JSON are ignored by Git.

## Database scripts

- `sql/schema.sql`: relational schema and constraints
- `sql/seed.sql`: roles, operator, stations, connectors, ports, links, and tariffs
- `sql/views.sql`: reporting and operational views
- `sql/routines.sql`: meter/audit triggers, booking/cancellation procedures, and session-duration function

Use UTC for stored `DATETIME(3)` values. The frontend converts browser-local booking times to ISO timestamps; the backend normalizes them before inserts. Payments are simulations and contain no real card information.

## Current implementation boundaries

This is a student demo, not a live charging operator. The booking workflow uses synthetic stations in the project database, and bookings do not reserve real public chargers. Search any Indian place to browse the nationwide BEE snapshot plus nearby OpenStreetMap/Overpass community records; Nominatim provides place search. BEE says its downloadable national list covers stations through 26 October 2025, so records may have since closed or changed. OSM coverage can also be incomplete. Neither source confirms a charger's current working state, live availability, or price. Public map records therefore show no quoted amount and link to a web search for the operator's tariff. The booking demo's seeded rates are fictional examples. The Ministry of Power guidelines describe components of public charging fees and ceilings for service charges; these are not a station's complete payable price. Confirm total rate, taxes, time-based charges, parking, and session fees with the operator before charging. Each public map entry links to Google Maps search for current details, photos, and reviews; the app does not claim review coverage is complete and does not copy or verify review text or ratings. OpenStreetMap's public tile service is best-effort and follows its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); this demo caches geocoding and charger searches in memory to reduce repeat requests.

Government charging guidance gives maximum service-fee components, not each station's total payable tariff; final charges also depend on electricity tariff, time band, land costs, taxes, and operator fees. See the [Ministry of Power's 2024 guidelines](https://powermin.gov.in/sites/default/files/Guidelines_and_Standards_for_EVCI_dated_17_09_2024.pdf) and verify a station's live price with its operator.

Other implementation boundaries: account roles are enforced by the API and database constraints, but MySQL grants for separately deployed customer accounts are not configured. Tariff billing applies energy and session fees; idle fees, tax rules, refunds, provider integration, and real-time charger hardware are not implemented. Port utilization definitions and larger graph/path optimization can be added after the workflows are stable.
