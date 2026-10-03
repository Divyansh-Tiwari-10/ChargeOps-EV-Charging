USE ev_network;

CREATE OR REPLACE VIEW v_user_charging_history AS
SELECT cs.user_id,cs.session_id,cs.started_at,cs.ended_at,
       s.station_id,s.name AS station_name,p.port_code,
       (cs.end_energy_kwh-cs.start_energy_kwh) AS energy_kwh,
       i.invoice_number,i.total_amount,i.currency,i.status AS invoice_status
FROM charging_session cs
JOIN charging_port p ON p.port_id=cs.port_id
JOIN charging_station s ON s.station_id=p.station_id
LEFT JOIN invoice i ON i.session_id=cs.session_id
WHERE cs.status='COMPLETED';

CREATE OR REPLACE VIEW v_upcoming_bookings AS
SELECT b.booking_id,b.user_id,b.vehicle_id,b.port_id,b.start_at,b.end_at,
       s.name AS station_name,s.city,p.port_code,p.max_power_kw
FROM booking b JOIN charging_port p ON p.port_id=b.port_id
JOIN charging_station s ON s.station_id=p.station_id
WHERE b.status='CONFIRMED' AND b.start_at>UTC_TIMESTAMP(3);

CREATE OR REPLACE VIEW v_station_port_status AS
SELECT s.station_id,s.name AS station_name,p.port_id,p.port_code,p.max_power_kw,
       p.operational_status,
       (p.operational_status='OPERATIONAL'
        AND NOT EXISTS(SELECT 1 FROM charging_session cs WHERE cs.port_id=p.port_id AND cs.status='ACTIVE')
        AND NOT EXISTS(SELECT 1 FROM booking b WHERE b.port_id=p.port_id AND b.status='CONFIRMED'
                       AND b.start_at<=UTC_TIMESTAMP(3) AND b.end_at>UTC_TIMESTAMP(3))) AS available_now
FROM charging_station s JOIN charging_port p ON p.station_id=s.station_id;

CREATE OR REPLACE VIEW v_energy_daily AS
SELECT s.operator_id,s.station_id,s.name AS station_name,DATE(cs.started_at) AS service_date,
       COUNT(*) AS completed_sessions,
       ROUND(SUM(cs.end_energy_kwh-cs.start_energy_kwh),3) AS energy_kwh
FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
JOIN charging_station s ON s.station_id=p.station_id
WHERE cs.status='COMPLETED'
GROUP BY s.operator_id,s.station_id,s.name,DATE(cs.started_at);

CREATE OR REPLACE VIEW v_operator_revenue_monthly AS
SELECT s.operator_id,DATE_FORMAT(pay.settled_at,'%Y-%m-01') AS month_start,
       pay.currency,SUM(pay.amount) AS collected_amount
FROM payment pay JOIN invoice i ON i.invoice_id=pay.invoice_id
JOIN charging_session cs ON cs.session_id=i.session_id
JOIN charging_port p ON p.port_id=cs.port_id
JOIN charging_station s ON s.station_id=p.station_id
WHERE pay.status='SUCCEEDED'
GROUP BY s.operator_id,DATE_FORMAT(pay.settled_at,'%Y-%m-01'),pay.currency;

CREATE OR REPLACE VIEW v_maintenance_summary AS
SELECT s.station_id,s.name AS station_name,p.port_id,p.port_code,
       SUM(m.status IN ('OPEN','ASSIGNED','IN_PROGRESS')) AS active_tickets,
       SUM(m.status IN ('OPEN','ASSIGNED','IN_PROGRESS') AND m.due_at<UTC_TIMESTAMP(3)) AS overdue_tickets,
       AVG(CASE WHEN m.resolved_at IS NOT NULL
           THEN TIMESTAMPDIFF(MINUTE,m.reported_at,m.resolved_at) END) AS avg_resolution_minutes
FROM charging_station s JOIN charging_port p ON p.station_id=s.station_id
LEFT JOIN maintenance_ticket m ON m.port_id=p.port_id
GROUP BY s.station_id,s.name,p.port_id,p.port_code;

CREATE OR REPLACE VIEW v_network_performance AS
SELECT s.operator_id,s.station_id,s.name AS station_name,s.city,
       COUNT(DISTINCT p.port_id) AS total_ports,
       SUM(p.operational_status='OPERATIONAL') AS operational_ports,
       COUNT(DISTINCT cs.session_id) AS completed_sessions,
       ROUND(COALESCE(SUM(cs.end_energy_kwh-cs.start_energy_kwh),0),3) AS energy_kwh
FROM charging_station s JOIN charging_port p ON p.station_id=s.station_id
LEFT JOIN charging_session cs ON cs.port_id=p.port_id AND cs.status='COMPLETED'
GROUP BY s.operator_id,s.station_id,s.name,s.city;
