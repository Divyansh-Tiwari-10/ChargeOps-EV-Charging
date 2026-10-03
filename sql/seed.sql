USE ev_network;

INSERT INTO app_role(role_id,role_name) VALUES
 (1,'CUSTOMER'),(2,'STATION_OPERATOR'),(3,'TECHNICIAN'),(4,'FINANCE'),(5,'ADMIN')
ON DUPLICATE KEY UPDATE role_name=VALUES(role_name);

INSERT INTO vehicle_model(model_id,make,model,model_year,battery_kwh) VALUES
 (1,'Tata','Nexon EV',2025,45.00),(2,'Hyundai','Kona Electric',2024,48.00),
 (3,'MG','ZS EV',2025,50.30),(4,'Mahindra','XUV400',2025,39.40)
ON DUPLICATE KEY UPDATE battery_kwh=VALUES(battery_kwh);

INSERT INTO network_operator(operator_id,legal_name,support_email) VALUES
 (1,'Western Grid Mobility Pvt Ltd','support@chargeops.test')
ON DUPLICATE KEY UPDATE legal_name=VALUES(legal_name);

INSERT INTO charging_station(station_id,operator_id,station_code,name,address,city,region,latitude,longitude,site_capacity_kw) VALUES
 (1,1,'PUN-01','Aundh Mobility Hub','12 Example Road','Pune','Maharashtra',18.560000,73.807000,180),
 (2,1,'PUN-02','Hinjawadi Tech Park','20 Sample Avenue','Pune','Maharashtra',18.591300,73.738900,240),
 (3,1,'MUM-01','Bandra Link Hub','8 Demo Street','Mumbai','Maharashtra',19.060000,72.836000,300),
 (4,1,'NAG-01','Civil Lines Charge Point','45 Fictional Marg','Nagpur','Maharashtra',21.145800,79.088200,150)
ON DUPLICATE KEY UPDATE name=VALUES(name),site_capacity_kw=VALUES(site_capacity_kw);

INSERT INTO connector_type(connector_id,connector_name) VALUES
 (1,'CCS2'),(2,'Type2'),(3,'CHAdeMO')
ON DUPLICATE KEY UPDATE connector_name=VALUES(connector_name);

INSERT INTO charging_port(port_id,station_id,port_code,max_power_kw,operational_status,installed_at) VALUES
 (1,1,'DC-01',60,'OPERATIONAL','2025-01-15'),(2,1,'AC-01',22,'OPERATIONAL','2025-01-15'),
 (3,1,'DC-02',120,'OPERATIONAL','2025-03-01'),(4,2,'DC-01',120,'OPERATIONAL','2025-03-01'),
 (5,2,'AC-01',22,'OPERATIONAL','2025-03-01'),(6,3,'DC-01',180,'OPERATIONAL','2025-04-10'),
 (7,3,'DC-02',60,'OUT_OF_SERVICE','2025-04-10'),(8,4,'DC-01',60,'OPERATIONAL','2025-05-01')
ON DUPLICATE KEY UPDATE max_power_kw=VALUES(max_power_kw);

INSERT INTO port_connector(port_id,connector_id) VALUES
 (1,1),(2,2),(3,1),(4,1),(5,2),(6,1),(7,1),(8,1),(8,3)
ON DUPLICATE KEY UPDATE connector_id=VALUES(connector_id);

INSERT INTO vehicle_model_connector(model_id,connector_id) VALUES
 (1,1),(1,2),(2,1),(2,2),(3,1),(3,2),(4,1)
ON DUPLICATE KEY UPDATE connector_id=VALUES(connector_id);

INSERT INTO station_link(from_station_id,to_station_id,distance_km,typical_drive_minutes) VALUES
 (1,2,11.50,28),(2,1,11.50,30),(1,3,148.00,195),(3,1,148.00,190),
 (2,4,710.00,650),(4,2,710.00,645),(3,4,820.00,720),(4,3,820.00,715)
ON DUPLICATE KEY UPDATE distance_km=VALUES(distance_km),typical_drive_minutes=VALUES(typical_drive_minutes);

INSERT INTO tariff(tariff_id,station_id,tariff_name,currency,energy_rate_per_kwh,session_fee,idle_rate_per_min,effective_from) VALUES
 (1,1,'Pune Standard 2026','INR',18.50,10.00,1.00,'2026-01-01 00:00:00.000'),
 (2,2,'Hinjawadi Standard 2026','INR',19.00,8.00,1.20,'2026-01-01 00:00:00.000'),
 (3,3,'Mumbai Standard 2026','INR',20.00,12.00,1.50,'2026-01-01 00:00:00.000'),
 (4,4,'Nagpur Standard 2026','INR',17.50,8.00,1.00,'2026-01-01 00:00:00.000')
ON DUPLICATE KEY UPDATE energy_rate_per_kwh=VALUES(energy_rate_per_kwh),session_fee=VALUES(session_fee);
