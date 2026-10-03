CREATE DATABASE IF NOT EXISTS ev_network CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
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
