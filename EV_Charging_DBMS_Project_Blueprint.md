# EV Charging Network Management and Smart Energy System

**Design baseline:** MySQL 8.0. Use InnoDB, `utf8mb4`, UTC for persisted timestamps, and the application/API as the trusted boundary for authentication. This is a design and implementation blueprint; SQL should be applied in phases and demonstrated against the exact MySQL minor version used by the team.

## 1. Critical evaluation and recommended scope

This is a strong DBMS topic for second-year CSE students because it has real temporal and transactional rules: a port cannot have two overlapping reservations, a session has a lifecycle, energy readings are cumulative, invoices must preserve the price used at the time, and station utilization requires aggregation over time. It naturally supports normalization, constraints, transactions, indexes, views, stored routines, audit history, and analytical SQL.

The weak version of this project is a station list plus a `booking` table. The overbuilt version tries to simulate a national roaming marketplace, live grid dispatch, payment gateways, subscriptions, coupons, refunds, and hardware telemetry. Those features create more state than a student team can explain or verify. The recommended case study is a **regional operator with several stations**, port-level reservations, metered charging, tariff snapshots, invoices/payments, maintenance, and a small station-connectivity graph. Model load capacity as an enforceable station rule, not as an AI claim. Use synthetic data and a simulated payment provider.

Differentiators: (1) race-safe booking and explicit conflict handling; (2) append-only meter and wallet ledgers; (3) tariff and invoice snapshots so history is reproducible; (4) maintenance-driven port availability; (5) a station graph for bounded-hop reachability; and (6) operator analytics with temporal queries. Core = booking/session/billing/maintenance. Optional = wallet, reviews, station links, richer load windows, external payment sandbox.

## 2. Project definition

**Title:** Design and Implementation of a Transaction-Safe EV Charging Network and Energy Management Database

**Problem statement.** A regional EV charging operator needs a reliable system to publish stations and ports, accept reservations without double-booking, record charging sessions and meter readings, calculate auditable bills from versioned tariffs, track payments and equipment faults, and report station utilization and energy demand. A collection of spreadsheets or loosely connected CRUD screens cannot enforce these rules consistently or provide trustworthy operational reports.

**Objective.** Build a normalized MySQL database and API that enforce the important business rules transactionally and expose useful operational and analytical workflows through a simple frontend.

**Scope.** One operator network; multiple stations; compatible vehicle/port connectors; advance reservations; walk-in sessions; session meter readings; flat per-kWh tariff plus optional session and idle fees; invoice and payment attempts; optional wallet ledger; maintenance tickets; reviews; station links; audit records; reporting. Excludes real payment processing, live hardware integration, dynamic market pricing, grid control, and multi-operator roaming in the required version.

**Stakeholders:** drivers/customers, network operator, station operator, maintenance technician, finance staff, system administrator, project evaluator.

**Assumptions:** users and EVs are registered; port compatibility is established by connector mapping; reservations are in UTC; a session may be booked or walk-in; charging hardware submits cumulative kWh readings; payment is simulated; invoice amounts are immutable snapshots; station and port statuses indicate operational condition, while live availability is computed from bookings/sessions.

**Functional requirements:** account/role assignment; vehicle registration; station/port discovery and connector filtering; availability search; reserve/cancel; begin/end session; record meter readings; calculate and issue invoice; record payment; report/assign/close maintenance; review a completed visit; operator dashboards; audit sensitive changes.

**Non-functional requirements:** referential integrity; race-safe writes; least privilege; UTC timestamps; password hashes only; idempotent API operations where appropriate; auditable financial data; useful query latency via measured indexes; graceful rollback on workflow failure.

## 3. Schema validation and modeling choices

The schema below has 24 tables. Each table owns one concept; multi-valued roles, vehicle-model connectors, and port connectors use bridge tables. Invoice lines retain monetary snapshots. Payments are attempts, not a single status field on an invoice. Wallet transactions are immutable ledger entries; the balance is derived. Port operational state is stored, but “available now” is not stored because it depends on time and active work. Booking overlap cannot be guaranteed with a MySQL `CHECK`; the booking procedure locks the port row, checks overlap, inserts, then commits. All booking creation paths must use that procedure/API transaction.

The central integrity decisions are:

* A vehicle belongs to one account; procedures verify that the booking/session account owns the selected vehicle.
* A session has one port and tariff snapshot, and at most one booking. A booking can create at most one session.
* A tariff is station-scoped and effective-dated. Prevent overlapping effective intervals per station in the tariff administration procedure.
* A session's meter values are cumulative and nondecreasing. The write procedure checks monotonicity and session state.
* A maintenance ticket can mark a port unavailable; set `charging_port.operational_status='OUT_OF_SERVICE'` in the maintenance workflow and restore it only after resolution and inspection.
* `DECIMAL`, not floating point, is used for money and kWh. UTC is used for stored `DATETIME` values; convert at the UI edge.

### Table inventory / data dictionary summary

| Table | Purpose, key(s), and important rules |
|---|---|
| `user_account` | Person/login; PK `user_id`, candidate `email`; unique email, password hash, active flag. |
| `app_role` | Application role catalog; PK `role_id`, unique `role_name`. |
| `user_role` | User-role M:N; composite PK `(user_id, role_id)`, FKs to both. |
| `vehicle_model` | Normalized make/model/specification; PK `model_id`, unique `(make, model, model_year)`. |
| `ev_vehicle` | User-owned registered EV; PK `vehicle_id`, unique `vin`, FK owner/model. |
| `network_operator` | Operator organization; PK `operator_id`, unique legal name. |
| `charging_station` | Site/location/capacity; PK `station_id`, FK operator, unique `(operator_id, station_code)`. |
| `connector_type` | Connector standard catalog; PK `connector_id`, unique name. |
| `charging_port` | EVSE outlet; PK `port_id`, FK station, unique `(station_id, port_code)`, operational status and max kW. |
| `port_connector` | Port-compatible connector M:N; composite PK `(port_id, connector_id)`. |
| `vehicle_model_connector` | Model-compatible connector M:N; composite PK `(model_id, connector_id)`, allowing compatibility validation at booking time. |
| `station_link` | Directed network edge; composite PK `(from_station_id,to_station_id)`, positive distance, no self-edge. |
| `tariff` | Station price version; PK `tariff_id`, FK station, effective interval, nonnegative rates. |
| `booking` | Time interval reservation; PK `booking_id`, FKs user/vehicle/port, status and timestamps. |
| `charging_session` | Actual charging event; PK `session_id`, optional unique booking, user/vehicle/port/tariff FKs, actual times and energy. |
| `meter_reading` | Cumulative meter samples; composite PK `(session_id, reading_no)`, unique `(session_id, recorded_at)`. |
| `invoice` | Final financial summary per session; PK `invoice_id`, unique session, immutable totals/status. |
| `invoice_line` | Bill detail/snapshot; PK `line_id`, FK invoice, description/quantity/rate/amount. |
| `payment` | Payment attempts and outcomes; PK `payment_id`, unique provider reference when present. |
| `wallet` | Optional user/currency ledger account; PK `wallet_id`, unique `(user_id,currency)`. |
| `wallet_transaction` | Immutable credits/debits; PK `wallet_txn_id`, FK wallet, unique idempotency key. |
| `maintenance_ticket` | Port fault, assignment, priority, status and lifecycle timestamps; PK `ticket_id`. |
| `review` | User feedback tied to a completed session; PK `review_id`, unique session. |
| `audit_log` | Append-only actor/action/entity/JSON change record; PK `audit_id`. |

The inventory has 24 tables. RBAC membership and connector compatibility are genuine M:N relationships, not duplicated text. Technician and station-operator identities are ordinary accounts with appropriate roles; a separate staff table is unnecessary for this scope. A dedicated `load_window` table, coupon/subscription entities, and payment-provider schema are intentionally deferred until a real requirement needs them.

### Attribute / type reference

All table definitions and constraints are explicit in the DDL section below. Important data types: identifiers are `BIGINT UNSIGNED`; money `DECIMAL(12,2)`; energy `DECIMAL(10,3)` kWh; power `DECIMAL(8,2)` kW; coordinates `DECIMAL(9,6)` and `DECIMAL(10,6)`; lifecycle times `DATETIME(3)`; calendar dates `DATE`; opening/closing clocks, if later added, `TIME`. Candidate keys are the unique constraints listed above. Status columns use `VARCHAR` plus `CHECK` for extensibility and consistent validation; use `ENUM` only if the team prefers a fixed lifecycle catalog and accepts schema changes when states evolve.

## 4. ER/EER model

**Entities:** Account, Role, VehicleModel, EV, Operator, Station, Port, ConnectorType, VehicleModelConnector, Tariff, Booking, ChargingSession, MeterReading, Invoice, InvoiceLine, Payment, Wallet, WalletTransaction, MaintenanceTicket, Review, StationLink, AuditLog.

**Relationships/cardinality/participation:** Account 1—0..N EV (each EV exactly one owner); VehicleModel 1—0..N EV (each EV exactly one model); VehicleModel M—N ConnectorType via VehicleModelConnector; Operator 1—1..N Station (each station exactly one operator); Station 1—1..N Port (each port exactly one station); Port M—N ConnectorType via PortConnector (both sides may exist before association); Station 1—0..N Tariff (each tariff exactly one station); Account 1—0..N Booking, EV 1—0..N Booking, Port 1—0..N Booking (each booking exactly one of each); Booking 1—0..1 Session; Account/EV/Port/Tariff each 1—0..N Sessions (each session exactly one of each except optional booking); Session 1—1..N MeterReading; Session 1—0..1 Invoice; Invoice 1—1..N InvoiceLine; Invoice 1—0..N Payment; Account 1—0..N Wallet and Wallet 1—0..N WalletTransaction; Port 1—0..N MaintenanceTicket; User 1—0..N assigned tickets; Session 1—0..1 Review; Station M—N Station via directed StationLink; Account 1—0..N AuditLog (actor optional for system actions); Account M—N Role via UserRole.

**Weak/dependent entities:** MeterReading depends on Session and uses a composite key. InvoiceLine depends on Invoice. UserRole and PortConnector are associative entities. No ISA hierarchy is needed: roles are many-to-many capabilities, not disjoint account subtypes. StationLink is a self-referencing relationship represented by an associative entity.

**Text diagram (recreate in draw.io):**

```text
USER_ACCOUNT ||--o{ EV_VEHICLE : owns
VEHICLE_MODEL ||--o{ EV_VEHICLE : describes
USER_ACCOUNT ||--o{ USER_ROLE }o--|| APP_ROLE
NETWORK_OPERATOR ||--|{ CHARGING_STATION : operates
CHARGING_STATION ||--|{ CHARGING_PORT : contains
CHARGING_PORT ||--o{ PORT_CONNECTOR }o--|| CONNECTOR_TYPE
VEHICLE_MODEL ||--o{ VEHICLE_MODEL_CONNECTOR }o--|| CONNECTOR_TYPE
CHARGING_STATION ||--o{ TARIFF : publishes
USER_ACCOUNT ||--o{ BOOKING : makes
EV_VEHICLE ||--o{ BOOKING : selected_for
CHARGING_PORT ||--o{ BOOKING : reserves
BOOKING ||--o| CHARGING_SESSION : fulfills
USER_ACCOUNT ||--o{ CHARGING_SESSION
EV_VEHICLE ||--o{ CHARGING_SESSION
CHARGING_PORT ||--o{ CHARGING_SESSION
TARIFF ||--o{ CHARGING_SESSION : price_snapshot_source
CHARGING_SESSION ||--|{ METER_READING
CHARGING_SESSION ||--o| INVOICE ||--|{ INVOICE_LINE
INVOICE ||--o{ PAYMENT
USER_ACCOUNT ||--o{ WALLET ||--|{ WALLET_TRANSACTION
CHARGING_PORT ||--o{ MAINTENANCE_TICKET
USER_ACCOUNT ||--o{ MAINTENANCE_TICKET : assigned_technician
CHARGING_SESSION ||--o| REVIEW
CHARGING_STATION ||--o{ STATION_LINK }o--|| CHARGING_STATION
USER_ACCOUNT ||--o{ AUDIT_LOG : actor
```

## 5. Normalization example

Start with a report-like UNF record:

```text
ChargeOrder(order_no, user_id, user_name, vehicle_id, vin, model_id, model_name,
 station_id, station_name, port_id, connector_names[], booking_start, booking_end,
 session_start, session_end, readings[(time,kwh)], tariff_id, rate, invoice_no,
 invoice_lines[(description,qty,unit_price)], payment_refs[])
```

The repeating connector/readings/invoice-line/payment groups violate 1NF. Flattening them creates duplicated user, vehicle, station and session facts. For a single-value 1NF staging relation, suppose key `(session_id, reading_no, invoice_line_no, payment_no)` is used to combine all repeating groups; this is a poor key and causes artificial row multiplication. The correct decomposition follows the functional dependencies instead.

Principal FDs (business candidate keys shown):

```text
user_id -> email, display_name
vehicle_id -> user_id, vin, model_id
model_id -> make, model, model_year, battery_kwh
operator_id -> legal_name
station_id -> operator_id, station_code, name, address, latitude, longitude, capacity_kw
port_id -> station_id, port_code, max_kw, operational_status
booking_id -> user_id, vehicle_id, port_id, start_at, end_at, status
session_id -> booking_id, user_id, vehicle_id, port_id, tariff_id, start_at, end_at, energy_kwh
(session_id, reading_no) -> recorded_at, cumulative_kwh
invoice_id -> session_id, invoice_no, currency, subtotal, tax, total, status
line_id -> invoice_id, description, quantity, unit_price, amount
payment_id -> invoice_id, amount, method, status, provider_reference
```

**1NF:** make every attribute atomic: one connector mapping per row; one meter sample per row; one invoice line per row; one payment attempt per row. These become `port_connector`, `meter_reading`, `invoice_line`, and `payment`.

**2NF:** in any relation keyed by a composite key, remove attributes depending on only part of it. In a flattened meter relation keyed `(session_id, reading_no)`, `session_start`, `port_id`, and `tariff_id` depend only on `session_id`, not the full key; retain them in `charging_session`. In `(port_id, connector_id)`, no non-key attributes are needed. Meter fields remain with the full composite key.

**3NF:** remove transitive dependencies. If a session relation includes `user_name`, `user_id -> user_name` creates `session_id -> user_id -> user_name`; keep account data in `user_account`. If it includes `station_name`, `port_id -> station_id -> station_name`; keep station data in `charging_station`. If it includes model name, keep it in `vehicle_model`. Do not derive historical invoice price from the current tariff; store the applied unit rate in `invoice_line` so later tariff changes do not rewrite history.

Final schema tables have attributes dependent on the key, the whole key, and no non-key determinant within each relation. Domain rules such as `end_at > start_at` use checks; cross-row non-overlap and effective-date exclusivity require transactions/procedures. `station_link` is naturally BCNF if the directed pair is its only determinant; `meter_reading` is BCNF under `(session_id,reading_no)` and its unique `(session_id,recorded_at)`. A station code may instead be globally unique if the real operator guarantees that; do not invent that rule.

## 6. MySQL 8.0 DDL

Apply in the listed order. The DDL is intentionally presented after the logical model. Test `CHECK` enforcement on the installed MySQL 8.0 release; checks are enforced in supported modern 8.0 versions. The database role/user creation belongs in a deployment-specific script, not a shared student seed file.

```sql
CREATE DATABASE ev_network CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ev_network;

CREATE TABLE user_account (
  user_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  phone VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_user_email (email)
) ENGINE=InnoDB;

CREATE TABLE app_role (
  role_id SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  role_name VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_role_name (role_name)
) ENGINE=InnoDB;

CREATE TABLE user_role (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id SMALLINT UNSIGNED NOT NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  FOREIGN KEY (role_id) REFERENCES app_role(role_id)
) ENGINE=InnoDB;

CREATE TABLE vehicle_model (
  model_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  make VARCHAR(60) NOT NULL,
  model VARCHAR(80) NOT NULL,
  model_year SMALLINT UNSIGNED NOT NULL,
  battery_kwh DECIMAL(8,2) NOT NULL,
  UNIQUE KEY uq_vehicle_model (make, model, model_year),
  CHECK (model_year BETWEEN 1990 AND 2100),
  CHECK (battery_kwh > 0)
) ENGINE=InnoDB;

CREATE TABLE ev_vehicle (
  vehicle_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  model_id BIGINT UNSIGNED NOT NULL,
  vin CHAR(17) NOT NULL,
  nickname VARCHAR(60),
  registered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_vehicle_vin (vin),
  KEY ix_vehicle_owner (user_id),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  FOREIGN KEY (model_id) REFERENCES vehicle_model(model_id)
) ENGINE=InnoDB;

CREATE TABLE network_operator (
  operator_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  legal_name VARCHAR(150) NOT NULL,
  support_email VARCHAR(254),
  UNIQUE KEY uq_operator_legal_name (legal_name)
) ENGINE=InnoDB;

CREATE TABLE charging_station (
  station_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  operator_id BIGINT UNSIGNED NOT NULL,
  station_code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  address VARCHAR(255) NOT NULL,
  city VARCHAR(80) NOT NULL,
  region VARCHAR(80) NOT NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(10,6) NOT NULL,
  site_capacity_kw DECIMAL(9,2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_station_code (operator_id, station_code),
  KEY ix_station_city_active (city, is_active),
  FOREIGN KEY (operator_id) REFERENCES network_operator(operator_id),
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (site_capacity_kw > 0)
) ENGINE=InnoDB;

CREATE TABLE connector_type (
  connector_id SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  connector_name VARCHAR(50) NOT NULL,
  UNIQUE KEY uq_connector_name (connector_name)
) ENGINE=InnoDB;

CREATE TABLE charging_port (
  port_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  station_id BIGINT UNSIGNED NOT NULL,
  port_code VARCHAR(30) NOT NULL,
  max_power_kw DECIMAL(8,2) NOT NULL,
  operational_status VARCHAR(24) NOT NULL DEFAULT 'OPERATIONAL',
  installed_at DATE,
  UNIQUE KEY uq_port_code (station_id, port_code),
  KEY ix_port_station_status (station_id, operational_status),
  FOREIGN KEY (station_id) REFERENCES charging_station(station_id),
  CHECK (max_power_kw > 0),
  CHECK (operational_status IN ('OPERATIONAL','OUT_OF_SERVICE','RETIRED'))
) ENGINE=InnoDB;

CREATE TABLE port_connector (
  port_id BIGINT UNSIGNED NOT NULL,
  connector_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (port_id, connector_id),
  FOREIGN KEY (port_id) REFERENCES charging_port(port_id),
  FOREIGN KEY (connector_id) REFERENCES connector_type(connector_id)
) ENGINE=InnoDB;

CREATE TABLE vehicle_model_connector (
  model_id BIGINT UNSIGNED NOT NULL,
  connector_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (model_id, connector_id),
  FOREIGN KEY (model_id) REFERENCES vehicle_model(model_id),
  FOREIGN KEY (connector_id) REFERENCES connector_type(connector_id)
) ENGINE=InnoDB;

CREATE TABLE station_link (
  from_station_id BIGINT UNSIGNED NOT NULL,
  to_station_id BIGINT UNSIGNED NOT NULL,
  distance_km DECIMAL(8,2) NOT NULL,
  typical_drive_minutes SMALLINT UNSIGNED,
  PRIMARY KEY (from_station_id, to_station_id),
  FOREIGN KEY (from_station_id) REFERENCES charging_station(station_id),
  FOREIGN KEY (to_station_id) REFERENCES charging_station(station_id),
  CHECK (from_station_id <> to_station_id),
  CHECK (distance_km > 0)
) ENGINE=InnoDB;

CREATE TABLE tariff (
  tariff_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  station_id BIGINT UNSIGNED NOT NULL,
  tariff_name VARCHAR(80) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  energy_rate_per_kwh DECIMAL(10,2) NOT NULL,
  session_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  idle_rate_per_min DECIMAL(10,2) NOT NULL DEFAULT 0,
  effective_from DATETIME(3) NOT NULL,
  effective_to DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_tariff_station_effective (station_id, effective_from, effective_to),
  FOREIGN KEY (station_id) REFERENCES charging_station(station_id),
  CHECK (energy_rate_per_kwh >= 0 AND session_fee >= 0 AND idle_rate_per_min >= 0),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
) ENGINE=InnoDB;

CREATE TABLE booking (
  booking_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  vehicle_id BIGINT UNSIGNED NOT NULL,
  port_id BIGINT UNSIGNED NOT NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at DATETIME(3),
  KEY ix_booking_port_interval (port_id, status, start_at, end_at),
  KEY ix_booking_user_start (user_id, start_at),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  FOREIGN KEY (vehicle_id) REFERENCES ev_vehicle(vehicle_id),
  FOREIGN KEY (port_id) REFERENCES charging_port(port_id),
  CHECK (end_at > start_at),
  CHECK (status IN ('CONFIRMED','CANCELLED','COMPLETED','NO_SHOW','EXPIRED'))
) ENGINE=InnoDB;

CREATE TABLE charging_session (
  session_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  booking_id BIGINT UNSIGNED UNIQUE,
  user_id BIGINT UNSIGNED NOT NULL,
  vehicle_id BIGINT UNSIGNED NOT NULL,
  port_id BIGINT UNSIGNED NOT NULL,
  tariff_id BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3),
  start_energy_kwh DECIMAL(10,3) NOT NULL DEFAULT 0,
  end_energy_kwh DECIMAL(10,3),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  KEY ix_session_port_status (port_id, status, started_at),
  KEY ix_session_user_started (user_id, started_at),
  FOREIGN KEY (booking_id) REFERENCES booking(booking_id),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  FOREIGN KEY (vehicle_id) REFERENCES ev_vehicle(vehicle_id),
  FOREIGN KEY (port_id) REFERENCES charging_port(port_id),
  FOREIGN KEY (tariff_id) REFERENCES tariff(tariff_id),
  CHECK (end_energy_kwh IS NULL OR end_energy_kwh >= start_energy_kwh),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (status IN ('ACTIVE','COMPLETED','ABORTED'))
) ENGINE=InnoDB;

CREATE TABLE meter_reading (
  session_id BIGINT UNSIGNED NOT NULL,
  reading_no INT UNSIGNED NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  cumulative_kwh DECIMAL(10,3) NOT NULL,
  PRIMARY KEY (session_id, reading_no),
  UNIQUE KEY uq_meter_time (session_id, recorded_at),
  FOREIGN KEY (session_id) REFERENCES charging_session(session_id),
  CHECK (cumulative_kwh >= 0)
) ENGINE=InnoDB;

CREATE TABLE invoice (
  invoice_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  invoice_number VARCHAR(40) NOT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  currency CHAR(3) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
  UNIQUE KEY uq_invoice_session (session_id),
  UNIQUE KEY uq_invoice_number (invoice_number),
  FOREIGN KEY (session_id) REFERENCES charging_session(session_id),
  CHECK (subtotal >= 0 AND tax_amount >= 0 AND total_amount = subtotal + tax_amount),
  CHECK (status IN ('UNPAID','PARTIALLY_PAID','PAID','VOID'))
) ENGINE=InnoDB;

CREATE TABLE invoice_line (
  line_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  line_type VARCHAR(24) NOT NULL,
  description VARCHAR(160) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoice(invoice_id),
  CHECK (quantity >= 0 AND unit_price >= 0 AND amount >= 0),
  CHECK (line_type IN ('ENERGY','SESSION_FEE','IDLE_FEE','ADJUSTMENT'))
) ENGINE=InnoDB;

CREATE TABLE payment (
  payment_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  method VARCHAR(24) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  provider_reference VARCHAR(100),
  attempted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at DATETIME(3),
  UNIQUE KEY uq_payment_provider_ref (provider_reference),
  KEY ix_payment_invoice_status (invoice_id, status),
  FOREIGN KEY (invoice_id) REFERENCES invoice(invoice_id),
  CHECK (amount > 0),
  CHECK (method IN ('CARD','UPI','WALLET','CASH_SIMULATED')),
  CHECK (status IN ('PENDING','SUCCEEDED','FAILED','REFUNDED'))
) ENGINE=InnoDB;

CREATE TABLE wallet (
  wallet_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallet_user_currency (user_id, currency),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB;

CREATE TABLE wallet_transaction (
  wallet_txn_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wallet_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED,
  idempotency_key VARCHAR(80) NOT NULL,
  txn_type VARCHAR(20) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallet_idempotency (idempotency_key),
  KEY ix_wallet_ledger (wallet_id, created_at),
  FOREIGN KEY (wallet_id) REFERENCES wallet(wallet_id),
  FOREIGN KEY (payment_id) REFERENCES payment(payment_id),
  CHECK (amount > 0),
  CHECK (txn_type IN ('TOP_UP','CHARGE','REFUND'))
) ENGINE=InnoDB;

CREATE TABLE maintenance_ticket (
  ticket_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  port_id BIGINT UNSIGNED NOT NULL,
  reported_by BIGINT UNSIGNED NOT NULL,
  assigned_to BIGINT UNSIGNED,
  fault_category VARCHAR(40) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  priority VARCHAR(12) NOT NULL DEFAULT 'NORMAL',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  reported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  due_at DATETIME(3),
  resolved_at DATETIME(3),
  KEY ix_maintenance_status_due (status, due_at),
  KEY ix_maintenance_port_status (port_id, status),
  FOREIGN KEY (port_id) REFERENCES charging_port(port_id),
  FOREIGN KEY (reported_by) REFERENCES user_account(user_id),
  FOREIGN KEY (assigned_to) REFERENCES user_account(user_id),
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'))
) ENGINE=InnoDB;

CREATE TABLE review (
  review_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  comment VARCHAR(1000),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_review_session (session_id),
  FOREIGN KEY (session_id) REFERENCES charging_session(session_id),
  FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  audit_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED,
  action_name VARCHAR(60) NOT NULL,
  entity_name VARCHAR(60) NOT NULL,
  entity_key VARCHAR(100) NOT NULL,
  before_data JSON,
  after_data JSON,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_entity_time (entity_name, entity_key, occurred_at),
  KEY ix_audit_actor_time (actor_user_id, occurred_at),
  FOREIGN KEY (actor_user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB;
```

## 7. Synthetic sample data plan

Seed a compact but analytically useful fixture: 8 accounts (one per role plus customers), 5 roles, 6 vehicle models, 8 EVs, 2 operators, 8 stations across 3 cities, 3 connector standards, 24 ports, 25 port-connector mappings, 10 directed station links, 12 tariffs across different effective periods, 30 bookings spread across past/current/future with several cancellations/no-shows, 18 sessions across at least 6 weeks, 4–8 meter readings per completed session, 16 invoices with multiple lines, a mixture of successful/failed/pending payments, 5 wallets with ledger entries, 6 maintenance tickets in different states, 8 reviews, and audit samples. Use fictional addresses, VIN-like synthetic identifiers, and amounts in INR. Include edge cases deliberately: one out-of-service port, one port with a future booking, one station with no active ports, one failed payment followed by success, one session without a booking, and one station-link cycle. This scale supports joins and ranking without pretending to be production telemetry.

Generate dates relative to a fixed seed date (or document the chosen seed date) so demonstrations remain reproducible. Do not use real passwords or personal data. For local dev, store clearly marked non-production password hashes or seed users through the application's password-hashing routine.

The following small, FK-consistent starter fixture covers every table. Expand repeated sessions/bookings and readings for analytics; keep account hashes as placeholders and replace them using the backend's password encoder.

```sql
INSERT INTO user_account(user_id,email,password_hash,display_name) VALUES
 (1,'maya@example.test','{replace-with-bcrypt}','Maya Rao'),
 (2,'arjun@example.test','{replace-with-bcrypt}','Arjun Shah'),
 (3,'tech@example.test','{replace-with-bcrypt}','Nila Das'),
 (4,'finance@example.test','{replace-with-bcrypt}','Dev Mehta');
INSERT INTO app_role(role_id,role_name) VALUES
 (1,'CUSTOMER'),(2,'STATION_OPERATOR'),(3,'TECHNICIAN'),(4,'FINANCE'),(5,'ADMIN');
INSERT INTO user_role(user_id,role_id) VALUES (1,1),(2,1),(3,3),(4,4);
INSERT INTO vehicle_model(model_id,make,model,model_year,battery_kwh) VALUES
 (1,'Tata','Nexon EV',2025,45.00),(2,'Hyundai','Kona Electric',2024,48.00);
INSERT INTO ev_vehicle(vehicle_id,user_id,model_id,vin,nickname) VALUES
 (1,1,1,'SYNTHETICVIN00001','Blue Nexon'),(2,2,2,'SYNTHETICVIN00002','Kona');
INSERT INTO network_operator(operator_id,legal_name,support_email) VALUES
 (1,'Western Grid Mobility Pvt Ltd','support@example.test');
INSERT INTO charging_station(station_id,operator_id,station_code,name,address,city,region,latitude,longitude,site_capacity_kw) VALUES
 (1,1,'PUN-01','Aundh Mobility Hub','12 Example Road','Pune','Maharashtra',18.560000,73.807000,180),
 (2,1,'PUN-02','Hinjawadi Tech Park','20 Sample Avenue','Pune','Maharashtra',18.591300,73.738900,240);
INSERT INTO connector_type(connector_id,connector_name) VALUES (1,'CCS2'),(2,'Type2'),(3,'CHAdeMO');
INSERT INTO charging_port(port_id,station_id,port_code,max_power_kw,operational_status,installed_at) VALUES
 (1,1,'DC-01',60,'OPERATIONAL','2025-01-15'),(2,1,'AC-01',22,'OPERATIONAL','2025-01-15'),
 (3,2,'DC-01',120,'OUT_OF_SERVICE','2025-03-01');
INSERT INTO port_connector(port_id,connector_id) VALUES (1,1),(2,2),(3,1);
INSERT INTO vehicle_model_connector(model_id,connector_id) VALUES (1,1),(1,2),(2,1),(2,2);
INSERT INTO station_link(from_station_id,to_station_id,distance_km,typical_drive_minutes) VALUES
 (1,2,11.50,28),(2,1,11.50,30);
INSERT INTO tariff(tariff_id,station_id,tariff_name,currency,energy_rate_per_kwh,session_fee,idle_rate_per_min,effective_from) VALUES
 (1,1,'Pune Standard 2026','INR',18.50,10.00,1.00,'2026-01-01 00:00:00.000'),
 (2,2,'Hinjawadi Standard 2026','INR',19.00,8.00,1.20,'2026-01-01 00:00:00.000');
INSERT INTO booking(booking_id,user_id,vehicle_id,port_id,start_at,end_at,status) VALUES
 (1,1,1,1,'2026-10-10 09:00:00.000','2026-10-10 10:00:00.000','CONFIRMED'),
 (2,2,2,2,'2026-10-10 11:00:00.000','2026-10-10 12:00:00.000','CONFIRMED'),
 (3,1,1,2,'2026-09-20 08:00:00.000','2026-09-20 09:00:00.000','COMPLETED');
INSERT INTO charging_session(session_id,booking_id,user_id,vehicle_id,port_id,tariff_id,started_at,ended_at,start_energy_kwh,end_energy_kwh,status) VALUES
 (1,3,1,1,2,1,'2026-09-20 08:02:00.000',NULL,120.000,NULL,'ACTIVE');
INSERT INTO meter_reading(session_id,reading_no,recorded_at,cumulative_kwh) VALUES
 (1,1,'2026-09-20 08:02:00.000',120.000),(1,2,'2026-09-20 08:20:00.000',132.250),
 (1,3,'2026-09-20 08:47:00.000',145.500);
UPDATE charging_session SET ended_at='2026-09-20 08:47:00.000',end_energy_kwh=145.500,status='COMPLETED'
WHERE session_id=1;
INSERT INTO invoice(invoice_id,session_id,invoice_number,currency,subtotal,tax_amount,total_amount,status) VALUES
 (1,1,'EV-2026-000001','INR',481.75,0.00,481.75,'PAID');
INSERT INTO invoice_line(invoice_id,line_type,description,quantity,unit_price,amount) VALUES
 (1,'ENERGY','Energy 25.5 kWh',25.500,18.50,471.75),(1,'SESSION_FEE','Session fee',1.000,10.00,10.00);
INSERT INTO payment(payment_id,invoice_id,amount,currency,method,status,provider_reference,settled_at) VALUES
 (1,1,481.75,'INR','WALLET','SUCCEEDED','SIM-PAY-0001','2026-09-20 08:50:00.000');
INSERT INTO wallet(wallet_id,user_id,currency) VALUES (1,1,'INR'),(2,2,'INR');
INSERT INTO wallet_transaction(wallet_id,payment_id,idempotency_key,txn_type,amount) VALUES
 (1,NULL,'seed-topup-1','TOP_UP',1000.00),(1,1,'seed-charge-1','CHARGE',481.75);
INSERT INTO maintenance_ticket(ticket_id,port_id,reported_by,assigned_to,fault_category,description,priority,status,reported_at,due_at) VALUES
 (1,3,2,3,'CONNECTOR_FAULT','Connector latch does not release','HIGH','IN_PROGRESS','2026-09-30 10:00:00.000','2026-10-02 10:00:00.000');
INSERT INTO review(session_id,user_id,rating,comment) VALUES (1,1,5,'Clear instructions and reliable charging.');
INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data) VALUES
 (1,'CREATE','booking','1',JSON_OBJECT('port_id',1,'status','CONFIRMED'));
```

Note: this tiny example uses one invoice/payment and a completed session for clarity. In a fuller fixture, wallet top-up should normally reference its own payment or funding event; avoid using one payment row to justify unrelated ledger entries. The wallet model above is optional and should either add a dedicated `wallet_funding` event or treat wallet top-ups as ledger entries with external references if implemented beyond the classroom demonstration.

## 8. Triggers, procedures, functions, and transaction rules

### Trigger policy

Keep cross-row business workflows in procedures/services. Triggers are appropriate for narrow, unavoidable invariants and audit capture, but make hidden writes visible in documentation and tests.

| Trigger | Business rule / timing / action |
|---|---|
| `trg_meter_reading_bi_monotonic` BEFORE INSERT | Reject readings unless the session is ACTIVE and timestamp/value exceed the latest sample. Session-writing routines lock the session row before insert to serialize samples. |
| `trg_maintenance_ticket_ai_audit` AFTER INSERT | Append an audit row for each new fault ticket using its reporter as actor. |
| Optional maintenance status trigger | Could mark a port unavailable when tickets become active, but restoration must check for other active tickets. Prefer maintenance procedures so restoration is explicit and transactional. |
| Optional payment trigger | Could synchronize invoice state after payment status changes, but a payment procedure is clearer for refunds and partial payments. |

The booking interval rule is enforced in `sp_book_port` under a port-row lock; a trigger alone cannot safely prevent concurrent overlapping inserts. A `CHECK` cannot query other rows.

CHECK is preferable for row-local ranges and amount rules. Procedures are preferable for overlap, ownership, payment settlement, tariff effective dates, port capacity and multi-table state transitions. Avoid triggers that call network services or create hidden financial side effects.

Executable examples for two narrow triggers and the core booking routine:

```sql
DELIMITER $$
CREATE TRIGGER trg_meter_reading_bi_monotonic
BEFORE INSERT ON meter_reading
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20) DEFAULT NULL;
  DECLARE v_last_kwh DECIMAL(10,3) DEFAULT NULL;
  DECLARE v_last_time DATETIME(3) DEFAULT NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN END;

  SELECT status INTO v_status FROM charging_session WHERE session_id=NEW.session_id;
  IF v_status IS NULL OR v_status <> 'ACTIVE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Meter reading requires an active session';
  END IF;
  SELECT cumulative_kwh,recorded_at INTO v_last_kwh,v_last_time
    FROM meter_reading WHERE session_id=NEW.session_id
    ORDER BY reading_no DESC LIMIT 1;
  IF v_last_kwh IS NOT NULL AND
     (NEW.cumulative_kwh < v_last_kwh OR NEW.recorded_at <= v_last_time) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Meter readings must increase in value and time';
  END IF;
END$$

CREATE TRIGGER trg_maintenance_ticket_ai_audit
AFTER INSERT ON maintenance_ticket
FOR EACH ROW
BEGIN
  INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
  VALUES(NEW.reported_by,'REPORT_FAULT','maintenance_ticket',CAST(NEW.ticket_id AS CHAR),
         JSON_OBJECT('port_id',NEW.port_id,'priority',NEW.priority,'status',NEW.status));
END$$

CREATE PROCEDURE sp_book_port(
  IN p_user_id BIGINT UNSIGNED,
  IN p_vehicle_id BIGINT UNSIGNED,
  IN p_port_id BIGINT UNSIGNED,
  IN p_start_at DATETIME(3),
  IN p_end_at DATETIME(3)
)
BEGIN
  DECLARE v_port_status VARCHAR(24);
  DECLARE v_owner BIGINT UNSIGNED;
  DECLARE v_conflicts INT DEFAULT 0;
  DECLARE v_booking_id BIGINT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  IF p_end_at <= p_start_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Booking end must be after start';
  END IF;
  START TRANSACTION;
  -- All booking writers lock this port first to serialize reservations.
  SELECT operational_status INTO v_port_status
    FROM charging_port WHERE port_id=p_port_id FOR UPDATE;
  IF v_port_status IS NULL OR v_port_status <> 'OPERATIONAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Port is not operational';
  END IF;
  SELECT user_id INTO v_owner FROM ev_vehicle WHERE vehicle_id=p_vehicle_id;
  IF v_owner IS NULL OR v_owner <> p_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Vehicle does not belong to user';
  END IF;
  SELECT COUNT(*) INTO v_conflicts FROM booking b
   WHERE b.port_id=p_port_id AND b.status='CONFIRMED'
     AND b.start_at < p_end_at AND b.end_at > p_start_at;
  IF v_conflicts > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Requested port interval is already booked';
  END IF;
  IF EXISTS(SELECT 1 FROM charging_session cs
            WHERE cs.port_id=p_port_id AND cs.status='ACTIVE') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Port currently has an active session';
  END IF;
  INSERT INTO booking(user_id,vehicle_id,port_id,start_at,end_at,status)
  VALUES(p_user_id,p_vehicle_id,p_port_id,p_start_at,p_end_at,'CONFIRMED');
  SET v_booking_id=LAST_INSERT_ID();
  INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
  VALUES(p_user_id,'BOOK','booking',CAST(v_booking_id AS CHAR),
         JSON_OBJECT('port_id',p_port_id,'start_at',p_start_at,'end_at',p_end_at));
  COMMIT;
  SELECT v_booking_id AS booking_id;
END$$
DELIMITER ;
```

The meter trigger uses a no-row handler because a session's first reading has no predecessor; the FK ensures the referenced session exists. Connector compatibility and tariff selection should be added to the booking/session procedures before using them in the application. The booking procedure demonstrates the critical serialization protocol; every booking writer must follow it.

### Stored routines and functions

| Routine | Inputs / outputs | Atomic work |
|---|---|---|
| `sp_register_vehicle` | user, model, VIN, nickname; returns vehicle id | Validate active account; insert vehicle; return id. |
| `sp_search_ports` | city or lat/lon radius, interval, connector, requested kW; result set | Read-only compatible-port search excluding operational faults and overlapping bookings/sessions. |
| `sp_book_port` | user, vehicle, port, start/end, idempotency key; booking id | Start transaction; lock port `FOR UPDATE`; validate ownership/status/connector/interval; insert booking; audit; commit, with exception handler rollback. |
| `sp_cancel_booking` | user/role, booking id; result | Lock booking; enforce owner and cutoff/status; mark cancelled; audit; commit. |
| `sp_start_session` | booking or walk-in identifiers; session id | Lock port and booking; validate time/status/vehicle; select currently effective station tariff; insert ACTIVE session and initial reading; commit. |
| `sp_end_session` | session id, final meter, end time; invoice id | Lock session; validate monotonic final reading; close session; calculate energy; create invoice and snapshot lines; mark booking completed; commit. Payment is a separate transaction. |
| `sp_record_payment` | invoice, amount, method, simulated result, idempotency/provider ref | Lock invoice; insert payment attempt; settle status and invoice consistently; wallet debit and ledger entry are atomic when applicable. |
| `sp_report_fault` | reporter, port, category, detail, priority; ticket id | Insert ticket; set port out of service; append audit in one transaction. |
| `sp_complete_maintenance` | ticket, technician, resolution | Lock ticket/port; mark resolved; restore port only if no other blocking ticket; audit. |

Useful deterministic/read functions: `fn_session_duration_minutes(start,end)`; `fn_wallet_balance(wallet_id)` returning signed ledger sum; `fn_session_energy(session_id)` from final minus initial meter; `fn_station_utilization(station_id,from,to)` (prefer a report query/view if a function would repeatedly scan many sessions). `fn_calculate_session_cost` is useful for display, but invoice creation should snapshot rates and amounts in the closing transaction. Avoid a function that queries mutable current tariffs to recalculate old invoices.

Example read functions (the balance assumes `TOP_UP` and `REFUND` are credits and `CHARGE` is a debit):

```sql
DELIMITER $$
CREATE FUNCTION fn_session_duration_minutes(p_start DATETIME(3),p_end DATETIME(3))
RETURNS BIGINT DETERMINISTIC NO SQL
BEGIN
  RETURN IF(p_end IS NULL,NULL,TIMESTAMPDIFF(SECOND,p_start,p_end) DIV 60);
END$$

CREATE FUNCTION fn_wallet_balance(p_wallet_id BIGINT UNSIGNED)
RETURNS DECIMAL(12,2) NOT DETERMINISTIC READS SQL DATA
BEGIN
  DECLARE v_balance DECIMAL(12,2);
  SELECT COALESCE(SUM(CASE WHEN txn_type IN ('TOP_UP','REFUND') THEN amount
                           WHEN txn_type='CHARGE' THEN -amount ELSE 0 END),0)
    INTO v_balance FROM wallet_transaction WHERE wallet_id=p_wallet_id;
  RETURN v_balance;
END$$
DELIMITER ;

**Concurrency note:** interval overlap is `existing.start_at < requested_end AND existing.end_at > requested_start`, among blocking statuses (`CONFIRMED`; also active sessions as needed). Locking the parent port serializes all app bookings for that port under InnoDB. Use a consistent lock order (port, booking/session, invoice) to reduce deadlocks. If any code path inserts bookings without the lock protocol, correctness is no longer guaranteed.

### Transactions and ACID examples

Booking transaction pseudocode (the procedure should use an EXIT HANDLER for `SQLEXCEPTION` that rolls back and re-signals):

```sql
START TRANSACTION;
SELECT operational_status FROM charging_port WHERE port_id = 12 FOR UPDATE;
-- application/procedure checks status and checks overlap using the predicate above
INSERT INTO booking(user_id,vehicle_id,port_id,start_at,end_at)
VALUES (3,5,12,'2026-10-10 09:00:00.000','2026-10-10 10:00:00.000');
SAVEPOINT after_booking;
-- optional simulated deposit/payment hold; on failure ROLLBACK TO SAVEPOINT after_booking
INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
VALUES (3,'BOOK','booking',LAST_INSERT_ID(),JSON_OBJECT('port_id',12));
COMMIT;
```

For a failed payment, record the failed attempt and commit that outcome; do not roll back the business fact that the provider declined. For a database error during booking/session close, roll back all partial state. Use `READ COMMITTED` or MySQL's default `REPEATABLE READ` with the explicit port lock; document the selected isolation level and test the two-client race. ACID: atomicity = booking and its audit/reservation state commit together; consistency = constraints and procedures preserve ownership/status/interval rules; isolation = port row lock serializes competing reservations; durability = InnoDB commit survives restart under configured durability settings.

Charging close transaction: lock session → validate ACTIVE → insert final reading → close session → compute kWh from cumulative meter delta → snapshot applicable session/energy/idle charges into invoice and invoice lines → complete booking → commit. Payment runs afterward so the invoice persists even if payment is declined.

## 9. Views

Create views for stable read use cases; use a reporting account with SELECT-only access.

| View | Contents / user |
|---|---|
| `v_user_charging_history` | User, station, times, kWh, invoice total and payment state; customer support/customer portal. |
| `v_upcoming_bookings` | Confirmed future bookings with station/port/connector; operator desk. |
| `v_station_port_status` | Operational port state plus current active session and current/future reservation indicators; availability screen. “Live” is query-time state. |
| `v_station_utilization_daily` | Daily occupied minutes / available operational port-minutes; operator analytics. State interval policy explicitly. |
| `v_operator_revenue_monthly` | Successful settled payments less refunded amounts, grouped by operator/month; finance. |
| `v_energy_daily` | Delivered kWh by station/day; energy manager. |
| `v_maintenance_summary` | Open tickets, overdue count and average resolution duration; technician lead. |
| `v_network_performance` | Station-level sessions, kWh, revenue, active ports and faults; management. |

Do not make up revenue by summing invoice totals when the question is collected cash: use successful payment entries. Keep views simple enough to inspect with `SHOW CREATE VIEW` and explain their freshness (ordinary MySQL views are not materialized).

## 10. Index plan and EXPLAIN

The DDL includes unique indexes and indexes tied to principal access paths. MySQL creates indexes needed for FK enforcement where absent; avoid adding duplicates blindly. Likely queries:

* Station discovery: `(city,is_active)` and port `(station_id,operational_status)`; if geo-distance search becomes important, use spatial columns/indexing as a separately justified extension.
* Compatibility: `port_connector` primary key starts with port; add reverse `(connector_id,port_id)` only if connector-first searches are frequent.
* Availability: `(port_id,status,start_at,end_at)` supports port-scoped interval filtering. Range predicates limit how many trailing columns can be used; verify the actual plan.
* User timeline: `(user_id,start_at)` for bookings and sessions.
* Revenue: payment `(invoice_id,status)` supports invoice settlement; time-based finance reports may justify `payment(status,settled_at)` after measuring.
* Maintenance queue: `(status,due_at)` for open/overdue dispatch; `(port_id,status)` for restoration checks.
* Audit: `(entity_name,entity_key,occurred_at)` and `(actor_user_id,occurred_at)`.

Do not index comments, low-selectivity boolean columns alone, every timestamp, or both orders of every composite index without evidence. Indexes consume storage and slow inserts/updates. Check plans using representative parameters:

```sql
EXPLAIN SELECT booking_id FROM booking
WHERE port_id=12 AND status='CONFIRMED'
  AND start_at < '2026-10-10 10:00:00' AND end_at > '2026-10-10 09:00:00';

EXPLAIN SELECT session_id, started_at FROM charging_session
WHERE user_id=3 AND started_at >= '2026-09-01' ORDER BY started_at DESC;

EXPLAIN SELECT payment_id FROM payment
WHERE invoice_id=44 AND status='SUCCEEDED';
```

Compare estimated rows/key before and after realistic seed data (`ANALYZE TABLE` after loading); do not claim an index helped solely because it exists.

## 11. RBAC and application security

There are two authorization layers. The application maps `user_role` to customer/operator/technician/finance/admin permissions and checks ownership on every request. MySQL accounts/roles protect service-to-database capabilities. Never connect as root from the API. A compact policy:

| Role | Allowed operations |
|---|---|
| Customer | Read public stations/availability; own vehicles/bookings/sessions/invoices/wallet; execute registration, booking, cancellation, review routines. No arbitrary user or payment updates. |
| Station operator | Read assigned network operational views; execute start/end session, fault/maintenance assignment routines; update station/port operational metadata through approved routines. |
| Technician | Read assigned tickets and relevant ports; update ticket progress/close through `sp_complete_maintenance`; no billing or user data. |
| Finance | Read invoice/payment/revenue views; execute payment reconciliation/refund routines; no station configuration or password data. |
| Administrator | Provision roles/configuration and audit; tightly limited direct data mutation; use separate admin credentials. |

In a classroom setup, demonstrate SQL roles with least-privilege grants on views/procedure execution, and explain that per-customer row ownership is best enforced in the API or with carefully designed views/routines. MySQL roles are database principals, not a substitute for end-user login. Use parameterized SQL, password hashing in the backend, secrets outside source control, and append-only audit access.

## 12. Complex SQL demonstration set

Queries below assume corresponding seeded data and MySQL 8.0. Status and amount semantics should be kept consistent with the DDL.

**A. Compatible operational ports and availability** (joins + `NOT EXISTS`):

```sql
SELECT s.station_id,s.name,p.port_id,p.port_code,p.max_power_kw
FROM charging_station s
JOIN charging_port p ON p.station_id=s.station_id
JOIN port_connector pc ON pc.port_id=p.port_id
JOIN connector_type c ON c.connector_id=pc.connector_id
WHERE s.city='Pune' AND s.is_active=TRUE
  AND p.operational_status='OPERATIONAL' AND c.connector_name='CCS2'
  AND p.max_power_kw >= 50
  AND NOT EXISTS (
    SELECT 1 FROM booking b WHERE b.port_id=p.port_id AND b.status='CONFIRMED'
      AND b.start_at < '2026-10-10 10:00:00' AND b.end_at > '2026-10-10 09:00:00'
  )
  AND NOT EXISTS (SELECT 1 FROM charging_session cs
    WHERE cs.port_id=p.port_id AND cs.status='ACTIVE');
```

**B. User's last completed sessions plus station, vehicle and invoice** (multi-table join, left join):

```sql
SELECT cs.session_id,s.name AS station,v.vin,cs.started_at,cs.ended_at,
       i.invoice_number,i.total_amount
FROM charging_session cs
JOIN charging_port p ON p.port_id=cs.port_id
JOIN charging_station s ON s.station_id=p.station_id
JOIN ev_vehicle v ON v.vehicle_id=cs.vehicle_id
LEFT JOIN invoice i ON i.session_id=cs.session_id
WHERE cs.user_id=3 AND cs.status='COMPLETED'
ORDER BY cs.started_at DESC LIMIT 10;
```

**C. Stations with no resolved/openly assigned maintenance activity** (`NOT EXISTS`, correlated):

```sql
SELECT s.station_id,s.name FROM charging_station s
WHERE NOT EXISTS (
 SELECT 1 FROM charging_port p JOIN maintenance_ticket m ON m.port_id=p.port_id
 WHERE p.station_id=s.station_id AND m.status IN ('OPEN','ASSIGNED','IN_PROGRESS')
);
```

**D. Revenue by station and month** (CTE + aggregation):

```sql
WITH paid AS (
 SELECT i.invoice_id, s.station_id, DATE_FORMAT(pay.settled_at,'%Y-%m-01') AS month_start,
        SUM(CASE WHEN pay.status='SUCCEEDED' THEN pay.amount ELSE 0 END) AS paid_amount
 FROM payment pay JOIN invoice i ON i.invoice_id=pay.invoice_id
 JOIN charging_session cs ON cs.session_id=i.session_id
 JOIN charging_port p ON p.port_id=cs.port_id
 JOIN charging_station s ON s.station_id=p.station_id
 WHERE pay.settled_at >= '2026-01-01' AND pay.settled_at < '2027-01-01'
 GROUP BY i.invoice_id,s.station_id,DATE_FORMAT(pay.settled_at,'%Y-%m-01')
)
SELECT station_id,month_start,SUM(paid_amount) revenue
FROM paid GROUP BY station_id,month_start ORDER BY month_start, revenue DESC;
```

**E. Rank stations by delivered energy each month** (`RANK`, partitioning):

```sql
WITH monthly AS (
 SELECT p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01') month_start,
        SUM(cs.end_energy_kwh-cs.start_energy_kwh) kwh
 FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
 WHERE cs.status='COMPLETED' AND cs.ended_at IS NOT NULL
 GROUP BY p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01')
)
SELECT *, RANK() OVER(PARTITION BY month_start ORDER BY kwh DESC) energy_rank
FROM monthly;
```

**F. Per-user session sequence and gap** (`ROW_NUMBER`, `LAG`):

```sql
SELECT user_id,session_id,started_at,
       ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY started_at) visit_no,
       TIMESTAMPDIFF(HOUR,LAG(ended_at) OVER(PARTITION BY user_id ORDER BY started_at),started_at) gap_hours
FROM charging_session WHERE status='COMPLETED';
```

**G. Running monthly energy** (window running total):

```sql
WITH monthly AS (
 SELECT DATE_FORMAT(started_at,'%Y-%m-01') month_start,
        SUM(end_energy_kwh-start_energy_kwh) kwh
 FROM charging_session WHERE status='COMPLETED'
 GROUP BY DATE_FORMAT(started_at,'%Y-%m-01')
)
SELECT month_start,kwh,
       SUM(kwh) OVER(ORDER BY month_start ROWS UNBOUNDED PRECEDING) cumulative_kwh
FROM monthly;
```

**H. Reachable stations in at most four directed hops** (recursive CTE):

```sql
WITH RECURSIVE reach(station_id,hops,path) AS (
 SELECT 1,0,CAST('/1/' AS CHAR(1000))
 UNION ALL
 SELECT l.to_station_id,r.hops+1,CONCAT(r.path,l.to_station_id,'/')
 FROM reach r JOIN station_link l ON l.from_station_id=r.station_id
 WHERE r.hops < 4 AND LOCATE(CONCAT('/',l.to_station_id,'/'),r.path)=0
)
SELECT station_id,MIN(hops) min_hops FROM reach GROUP BY station_id;
```

This finds graph reachability, not an energy-feasible route. Add range, battery, elevation and charger compatibility only if modeled credibly.

**I. Peak charging hour** (date/time extraction + aggregation):

```sql
SELECT HOUR(started_at) hour_of_day,COUNT(*) sessions,
       SUM(end_energy_kwh-start_energy_kwh) kwh
FROM charging_session WHERE status='COMPLETED'
  AND started_at >= '2026-09-01' AND started_at < '2026-10-01'
GROUP BY HOUR(started_at) ORDER BY sessions DESC;
```

**J. Overdue maintenance** (date/time):

```sql
SELECT ticket_id,port_id,priority,due_at,TIMESTAMPDIFF(HOUR,due_at,UTC_TIMESTAMP(3)) overdue_hours
FROM maintenance_ticket WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS')
  AND due_at < UTC_TIMESTAMP(3) ORDER BY due_at;
```

**K. Network adjacency display** (`SELF JOIN`):

```sql
SELECT origin.name AS station, neighbor.name AS directly_reachable,
       link.distance_km,link.typical_drive_minutes
FROM station_link link
JOIN charging_station origin ON origin.station_id=link.from_station_id
JOIN charging_station neighbor ON neighbor.station_id=link.to_station_id
ORDER BY origin.name,link.distance_km;
```

**L. Station month rank with ties** (`DENSE_RANK`) and scalar benchmark:

```sql
WITH station_energy AS (
 SELECT p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01') month_start,
        SUM(cs.end_energy_kwh-cs.start_energy_kwh) kwh
 FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
 WHERE cs.status='COMPLETED'
 GROUP BY p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01')
)
SELECT station_id,month_start,kwh,
       DENSE_RANK() OVER(PARTITION BY month_start ORDER BY kwh DESC) energy_rank,
       (SELECT AVG(total_amount) FROM invoice WHERE status IN ('PAID','PARTIALLY_PAID')) AS network_avg_invoice
FROM station_energy;
```

**M. Next charging visit** (`LEAD`):

```sql
SELECT user_id,session_id,started_at,
       LEAD(started_at) OVER(PARTITION BY user_id ORDER BY started_at) next_visit_at
FROM charging_session WHERE status='COMPLETED';
```

**N. Two-stage CTE** (monthly energy first, ranked result second):

```sql
WITH monthly_energy AS (
 SELECT p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01') month_start,
        SUM(cs.end_energy_kwh-cs.start_energy_kwh) kwh
 FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
 WHERE cs.status='COMPLETED'
 GROUP BY p.station_id,DATE_FORMAT(cs.started_at,'%Y-%m-01')
), ranked_energy AS (
 SELECT station_id,month_start,kwh,
        ROW_NUMBER() OVER(PARTITION BY month_start ORDER BY kwh DESC) position
 FROM monthly_energy
)
SELECT * FROM ranked_energy WHERE position <= 3 ORDER BY month_start,position;
```

Concepts: joins express relationships; `EXISTS`/correlated predicates express set membership; CTEs stage logic; recursive CTE walks adjacency; window functions rank or compare rows without collapsing them; grouping and date functions support operations analytics.

## 13. Backend and REST API

**Recommendation: Java Spring Boot + MySQL.** It teaches layered architecture, transactions (`@Transactional`), JDBC/JPA plus stored procedure calls, validation, and role-based endpoint security, and has strong resume value. Use JDBC or `JdbcTemplate` for multi-step SQL and routines rather than hiding all logic behind ORM. Node/Express is simpler to start and good for rapid APIs but requires choosing transaction discipline and types carefully. Python FastAPI is concise and offers clear request validation, but students may need to explain database transaction boundaries and deployment choices. Any stack can be reliable if connection pooling, parameter binding, migrations, and explicit transactions are used.

Frontend can be a small web app with customer, operator, technician and finance views. Backend layers: REST controller → service/workflow transaction → repository/SQL routine → MySQL; DTO validation; centralized errors; structured logs; database migration scripts. Use Flyway migrations and environment-based config as recommended additions.

| Method + URL | Purpose / inputs | Response idea |
|---|---|---|
| `POST /api/auth/login` | email/password | access token + role claims (never return hash). |
| `GET /api/stations?city=&connector=&from=&to=` | Search and availability filters | station/port availability summaries. |
| `GET /api/stations/{id}` | Station details | location, ports, tariffs. |
| `GET /api/ports/{id}/availability?from=&to=` | Check an interval | compatible and bookable result. |
| `POST /api/vehicles` | model, VIN, nickname | created vehicle. |
| `POST /api/bookings` | vehicle, port, from/to, idempotency key | booking or 409 conflict. |
| `DELETE /api/bookings/{id}` | owner booking | cancelled state. |
| `POST /api/sessions` | booking id or walk-in vehicle/port | started session. |
| `POST /api/sessions/{id}/meter-readings` | recorded time, cumulative kWh | accepted reading. |
| `POST /api/sessions/{id}/complete` | final meter | closed session + invoice summary. |
| `POST /api/invoices/{id}/payments` | method, amount, simulated outcome/idempotency key | payment result and invoice state. |
| `POST /api/ports/{id}/maintenance` | category, description, priority | ticket and port status. |
| `PATCH /api/maintenance/{id}` | assignment/status/resolution | updated ticket. |
| `POST /api/sessions/{id}/review` | rating/comment | review. |
| `GET /api/operator/analytics/energy?from=&to=` | authorized reporting window | station/day energy report. |
| `GET /api/operator/analytics/utilization?from=&to=` | authorized window | utilization by station. |

Use `409 Conflict` for booking race conflict, `403` for authorization failure, `404` for hidden/nonexistent owned records, `422` for validly parsed but invalid domain input. Keep card data out of the project entirely; simulated payment should be clearly labeled.

## 14. Testing strategy

Testing is recommended for implementation; no tests are run as part of this design response. Build unit tests for validation, repository integration tests against the target MySQL version, and two-connection concurrency tests for booking. Test at least:

| Case | Expected result |
|---|---|
| valid booking | committed booking, audit row, port lock released |
| overlapping booking | second request rejected; no partial rows |
| two simultaneous same-port overlapping requests | exactly one succeeds |
| vehicle owned by another user | reject; no booking/session |
| inactive EV/account or invalid model FK | reject |
| unavailable/out-of-service port | reject booking/session start |
| connector mismatch / insufficient power | excluded or rejected |
| failed payment | failed attempt retained; invoice remains unpaid |
| successful partial/full payment | invoice state matches settled total |
| forced error after insert | rollback removes all partial workflow state |
| savepoint deposit failure | roll back optional deposit step as documented |
| session final meter lower than latest | reject and leave session active |
| successful session completion | final reading, invoice, lines, booking, session consistent |
| maintenance completion with another active ticket | port remains out of service |
| role restriction | customer cannot read/update another account's records |
| invalid FK / duplicate VIN/email/invoice | DB rejects |
| tariff effective interval overlap | admin procedure rejects |
| wallet idempotency replay | no duplicate debit/credit |

## 15. 12-minute demonstration flow

1. Explain the case study and show the ER diagram (45 sec).
2. Log in as a customer and search compatible ports for a time window (60 sec).
3. Show the station/port availability view and connector mapping (45 sec).
4. Create a booking; show transaction and audit row (60 sec).
5. Attempt an overlapping booking; show 409/rejection and unchanged row counts (45 sec).
6. Start the session; add cumulative meter samples and show trigger validation (60 sec).
7. Submit a decreasing meter sample to show rejection (30 sec).
8. End session; show invoice snapshot lines and tariff used (90 sec).
9. Simulate failed payment, then successful payment; show invoice status (60 sec).
10. Report a port fault; show it disappears from availability; technician resolves it (60 sec).
11. Run monthly energy ranking and recursive station reachability query (90 sec).
12. Show query plan for availability index and one rollback/savepoint demo (60 sec).
13. Switch to customer/technician/finance permissions and show denied access (60 sec).

Keep the database client ready with exact queries and seeded IDs. Explain the business rule before showing SQL so the complexity is meaningful.

## 16. Report structure

1. Abstract
2. Introduction and domain background
3. Existing system and limitations
4. Problem statement, objectives, scope, assumptions
5. Case study and stakeholder analysis
6. Requirement analysis (functional/non-functional/use cases)
7. Proposed architecture and data-flow diagram
8. ER/EER diagram and cardinality notes
9. Relational schema and data dictionary
10. Normalization and functional dependencies
11. MySQL implementation and constraints
12. Triggers, procedures and functions
13. Views, indexes and `EXPLAIN` observations
14. Transaction workflows and ACID discussion
15. RBAC and application security
16. Backend/API and frontend overview
17. Synthetic data and screenshots/results
18. Test plan and outcomes
19. Limitations and future scope
20. Conclusion and references

## 17. Resume positioning

**Alternative titles:**

* EV ChargeOps: Transaction-Safe Charging Network Database
* SmartCharge Network Management and Energy Analytics
* EV Charging Reservation, Metering and Billing Platform

**Resume description (only claim completed features):** “Designed a normalized MySQL platform for a multi-station EV charging network, with race-safe port reservations, metered charging sessions, tariff-snapshot invoicing, maintenance workflows, and role-aware APIs. Implemented transactional stored routines, audit/ledger records, analytical views, composite indexes, and MySQL 8 CTE/window-function reports.”

**Skills demonstrated:** relational modeling and normalization; MySQL/InnoDB constraints and indexing; transactions and concurrency control; stored procedures/triggers/views; REST API and role-based authorization; query plans and analytical SQL; integration testing; temporal data modeling.

## Final recommended architecture

1. **Tables:** `user_account`, `app_role`, `user_role`, `vehicle_model`, `ev_vehicle`, `vehicle_model_connector`, `network_operator`, `charging_station`, `connector_type`, `charging_port`, `port_connector`, `station_link`, `tariff`, `booking`, `charging_session`, `meter_reading`, `invoice`, `invoice_line`, `payment`, `wallet`, `wallet_transaction`, `maintenance_ticket`, `review`, `audit_log`.
2. **Major relationships:** operator→station→port; port↔connector; station↔station links; user→vehicle/booking/session/wallet; booking→optional session; station→tariff→session snapshot; session→readings/invoice/review; invoice→lines/payments; port→maintenance; user↔roles.
3. **Core workflows:** availability search; lock-and-check booking; start session; monotonic meter capture; transactional close/invoice; separate payment settlement; fault/maintenance and port restoration.
4. **Triggers:** meter monotonicity defense; booking row validation defense; maintenance status/audit; payment-to-invoice settlement only if payment mutations are tightly controlled. Keep interval concurrency and multi-row operations in procedures.
5. **Procedures/functions:** register EV, search ports, book/cancel, start/end session, record payment, report/complete maintenance; duration, session energy, wallet balance, optional cost preview.
6. **Views:** user history, upcoming bookings, port status, daily utilization, operator revenue, daily energy, maintenance summary, network performance.
7. **Indexes:** unique business keys; availability `(port_id,status,start_at,end_at)`; user timelines `(user_id,start_at)`; station discovery `(city,is_active)`; connector reverse lookup only if used; payment settlement, maintenance queue, audit lookup indexes.
8. **Roles:** customer, station operator, technician, finance, administrator, enforced in API and constrained DB service accounts.
9. **Advanced SQL:** correlated `NOT EXISTS` availability, multitable history joins, CTE revenue, monthly `RANK`, `LAG` repeat visits, running totals, peak-hour reports, overdue maintenance, bounded-hop recursive reachability, and measured `EXPLAIN` plans.
10. **Backend:** Spring Boot, JDBC/JdbcTemplate for critical workflows, MySQL 8.0/InnoDB, Flyway; a small frontend.
11. **Optional after core correctness:** load-window demand caps, refunds, promotions/subscriptions, roaming, spatial search, hardware integration, and a payment sandbox.
