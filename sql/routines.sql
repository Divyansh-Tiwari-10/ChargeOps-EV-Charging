USE ev_network;
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
     (NEW.cumulative_kwh <= v_last_kwh OR NEW.recorded_at <= v_last_time) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Meter values and times must increase';
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
  DECLARE v_port_status VARCHAR(24) DEFAULT NULL;
  DECLARE v_owner BIGINT UNSIGNED DEFAULT NULL;
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
  SELECT operational_status INTO v_port_status
    FROM charging_port WHERE port_id=p_port_id FOR UPDATE;
  IF v_port_status IS NULL OR v_port_status <> 'OPERATIONAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Port is not operational';
  END IF;
  SELECT user_id INTO v_owner FROM ev_vehicle WHERE vehicle_id=p_vehicle_id;
  IF v_owner IS NULL OR v_owner <> p_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Vehicle does not belong to user';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM ev_vehicle v JOIN vehicle_model_connector vmc ON vmc.model_id=v.model_id
    JOIN port_connector pc ON pc.connector_id=vmc.connector_id AND pc.port_id=p_port_id
    WHERE v.vehicle_id=p_vehicle_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Vehicle connector is incompatible with port';
  END IF;
  SELECT COUNT(*) INTO v_conflicts FROM booking b
   WHERE b.port_id=p_port_id AND b.status='CONFIRMED'
     AND b.start_at < p_end_at AND b.end_at > p_start_at;
  IF v_conflicts > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Requested port interval is already booked';
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

CREATE PROCEDURE sp_cancel_booking(IN p_user_id BIGINT UNSIGNED, IN p_booking_id BIGINT UNSIGNED)
BEGIN
  DECLARE v_status VARCHAR(20) DEFAULT NULL;
  DECLARE v_start DATETIME(3) DEFAULT NULL;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  START TRANSACTION;
  SELECT status,start_at INTO v_status,v_start FROM booking
   WHERE booking_id=p_booking_id AND user_id=p_user_id FOR UPDATE;
  IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Booking was not found'; END IF;
  IF v_status <> 'CONFIRMED' OR v_start <= UTC_TIMESTAMP(3) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Booking can no longer be cancelled';
  END IF;
  UPDATE booking SET status='CANCELLED',cancelled_at=UTC_TIMESTAMP(3) WHERE booking_id=p_booking_id;
  INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
  VALUES(p_user_id,'CANCEL','booking',CAST(p_booking_id AS CHAR),JSON_OBJECT('status','CANCELLED'));
  COMMIT;
END$$

CREATE FUNCTION fn_session_duration_minutes(p_start DATETIME(3),p_end DATETIME(3))
RETURNS BIGINT DETERMINISTIC NO SQL
BEGIN
  RETURN IF(p_end IS NULL,NULL,TIMESTAMPDIFF(SECOND,p_start,p_end) DIV 60);
END$$

DELIMITER ;
