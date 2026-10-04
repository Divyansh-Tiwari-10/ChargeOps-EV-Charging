import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const demoPassword = process.env.DEMO_PASSWORD || 'ChargeOps!2026';
const demoUsers = [
  { email:'maya@chargeops.test', name:'Maya Rao', role:'CUSTOMER' },
  { email:'arjun@chargeops.test', name:'Arjun Shah', role:'CUSTOMER' },
  { email:'nila@chargeops.test', name:'Nila Das', role:'TECHNICIAN' },
  { email:'dev@chargeops.test', name:'Dev Mehta', role:'FINANCE' },
  { email:'ops@chargeops.test', name:'Ira Kulkarni', role:'STATION_OPERATOR' },
  { email:'admin@chargeops.test', name:'Project Admin', role:'ADMIN' }
];
const demoHubs = [
  { code:'DEL-TEST-01', name:'Delhi NCR Sample Hub', address:'Simulated site · Connaught Place', city:'New Delhi', region:'Delhi', lat:28.6315, lon:77.2167, rate:19.5 },
  { code:'JAI-TEST-01', name:'Jaipur Sample Hub', address:'Simulated site · MI Road', city:'Jaipur', region:'Rajasthan', lat:26.9157, lon:75.8180, rate:18.5 },
  { code:'LKO-TEST-01', name:'Lucknow Sample Hub', address:'Simulated site · Gomti Nagar', city:'Lucknow', region:'Uttar Pradesh', lat:26.8467, lon:80.9462, rate:18.0 },
  { code:'PAT-TEST-01', name:'Patna Sample Hub', address:'Simulated site · Fraser Road', city:'Patna', region:'Bihar', lat:25.6093, lon:85.1376, rate:17.5 },
  { code:'RNC-TEST-01', name:'Ranchi Sample Hub', address:'Simulated site · Main Road', city:'Ranchi', region:'Jharkhand', lat:23.3441, lon:85.3096, rate:17.5 },
  { code:'KOL-TEST-01', name:'Kolkata Sample Hub', address:'Simulated site · Park Street', city:'Kolkata', region:'West Bengal', lat:22.5535, lon:88.3536, rate:19.0 },
  { code:'BBI-TEST-01', name:'Bhubaneswar Sample Hub', address:'Simulated site · Jaydev Vihar', city:'Bhubaneswar', region:'Odisha', lat:20.2961, lon:85.8245, rate:18.0 },
  { code:'GAU-TEST-01', name:'Guwahati Sample Hub', address:'Simulated site · GS Road', city:'Guwahati', region:'Assam', lat:26.1445, lon:91.7362, rate:19.0 },
  { code:'AMD-TEST-01', name:'Ahmedabad Sample Hub', address:'Simulated site · SG Highway', city:'Ahmedabad', region:'Gujarat', lat:23.0396, lon:72.5085, rate:18.5 },
  { code:'SUR-TEST-01', name:'Surat Sample Hub', address:'Simulated site · Adajan', city:'Surat', region:'Gujarat', lat:21.1702, lon:72.8311, rate:18.5 },
  { code:'BPL-TEST-01', name:'Bhopal Sample Hub', address:'Simulated site · MP Nagar', city:'Bhopal', region:'Madhya Pradesh', lat:23.2330, lon:77.4343, rate:17.5 },
  { code:'RPR-TEST-01', name:'Raipur Sample Hub', address:'Simulated site · Telibandha', city:'Raipur', region:'Chhattisgarh', lat:21.2514, lon:81.6296, rate:17.5 },
  { code:'BLR-TEST-01', name:'Bengaluru Sample Hub', address:'Simulated site · MG Road', city:'Bengaluru', region:'Karnataka', lat:12.9756, lon:77.6066, rate:20.0 },
  { code:'HYD-TEST-01', name:'Hyderabad Sample Hub', address:'Simulated site · HITEC City', city:'Hyderabad', region:'Telangana', lat:17.4435, lon:78.3772, rate:19.5 },
  { code:'CHE-TEST-01', name:'Chennai Sample Hub', address:'Simulated site · T Nagar', city:'Chennai', region:'Tamil Nadu', lat:13.0418, lon:80.2341, rate:19.0 },
  { code:'CBE-TEST-01', name:'Coimbatore Sample Hub', address:'Simulated site · Race Course', city:'Coimbatore', region:'Tamil Nadu', lat:11.0056, lon:76.9661, rate:18.5 },
  { code:'VSK-TEST-01', name:'Visakhapatnam Sample Hub', address:'Simulated site · Dwaraka Nagar', city:'Visakhapatnam', region:'Andhra Pradesh', lat:17.7294, lon:83.3042, rate:18.5 },
  { code:'COK-TEST-01', name:'Kochi Sample Hub', address:'Simulated site · Marine Drive', city:'Kochi', region:'Kerala', lat:9.9816, lon:76.2999, rate:19.0 },
  { code:'TVM-TEST-01', name:'Thiruvananthapuram Sample Hub', address:'Simulated site · Kowdiar', city:'Thiruvananthapuram', region:'Kerala', lat:8.5241, lon:76.9366, rate:18.5 },
  { code:'GOA-TEST-01', name:'Panaji Sample Hub', address:'Simulated site · Panaji', city:'Panaji', region:'Goa', lat:15.4909, lon:73.8278, rate:20.0 }
];

function sqlDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

async function ensureDemoHubs() {
  const [[operator]] = await pool.execute('SELECT operator_id FROM network_operator WHERE legal_name=?', ['Western Grid Mobility Pvt Ltd']);
  const [[connector]] = await pool.execute('SELECT connector_id FROM connector_type WHERE connector_name=?', ['CCS2']);
  if (!operator || !connector) throw new Error('Run the database schema and base seed before creating sample booking hubs.');
  for (const hub of demoHubs) {
    await pool.execute(
      `INSERT INTO charging_station(operator_id,station_code,name,address,city,region,latitude,longitude,site_capacity_kw,is_active)
       VALUES(?,?,?,?,?,?,?,?,120,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),address=VALUES(address),city=VALUES(city),region=VALUES(region),
       latitude=VALUES(latitude),longitude=VALUES(longitude),site_capacity_kw=VALUES(site_capacity_kw),is_active=TRUE`,
      [operator.operator_id,hub.code,hub.name,hub.address,hub.city,hub.region,hub.lat,hub.lon]
    );
    const [[station]] = await pool.execute('SELECT station_id FROM charging_station WHERE operator_id=? AND station_code=?', [operator.operator_id,hub.code]);
    await pool.execute(
      `INSERT INTO charging_port(station_id,port_code,max_power_kw,operational_status,installed_at)
       VALUES(?,'DC-01',60,'OPERATIONAL',CURRENT_DATE)
       ON DUPLICATE KEY UPDATE max_power_kw=VALUES(max_power_kw),operational_status='OPERATIONAL'`, [station.station_id]
    );
    const [[port]] = await pool.execute('SELECT port_id FROM charging_port WHERE station_id=? AND port_code=?', [station.station_id,'DC-01']);
    await pool.execute('INSERT IGNORE INTO port_connector(port_id,connector_id) VALUES(?,?)', [port.port_id,connector.connector_id]);
    const [[tariff]] = await pool.execute('SELECT tariff_id FROM tariff WHERE station_id=? AND tariff_name=? LIMIT 1', [station.station_id,'ChargeOps simulated sample rate']);
    if (!tariff) await pool.execute(
      `INSERT INTO tariff(station_id,tariff_name,currency,energy_rate_per_kwh,session_fee,idle_rate_per_min,effective_from)
       VALUES(?,'ChargeOps simulated sample rate','INR',?,10,0,UTC_TIMESTAMP(3))`, [station.station_id,hub.rate]
    );
  }
}

async function ensureUser(user) {
  const [rows] = await pool.execute('SELECT user_id FROM user_account WHERE email=?', [user.email]);
  let userId = rows[0]?.user_id;
  if (!userId) {
    const hash = await bcrypt.hash(demoPassword, 12);
    const [insert] = await pool.execute(
      'INSERT INTO user_account(email,password_hash,display_name) VALUES(?,?,?)', [user.email, hash, user.name]
    );
    userId = insert.insertId;
  }
  const [[role]] = await pool.execute('SELECT role_id FROM app_role WHERE role_name=?', [user.role]);
  await pool.execute('INSERT IGNORE INTO user_role(user_id,role_id) VALUES(?,?)', [userId, role.role_id]);
  if (user.role === 'CUSTOMER') await pool.execute("INSERT IGNORE INTO wallet(user_id,currency) VALUES(?,'INR')", [userId]);
  return userId;
}

async function main() {
  await ensureDemoHubs();
  const ids = {};
  for (const user of demoUsers) ids[user.role === 'CUSTOMER' ? user.email.split('@')[0] : user.role.toLowerCase()] = await ensureUser(user);
  const mayaId = ids.maya;
  const arjunId = ids.arjun;
  const technicianId = ids.technician;
  const vehicles = [
    { owner:mayaId,model:1,vin:'SYNTHETICVIN00001',nickname:'Blue Nexon' },
    { owner:mayaId,model:3,vin:'SYNTHETICVIN00003',nickname:'City ZS' },
    { owner:arjunId,model:2,vin:'SYNTHETICVIN00002',nickname:'Kona' },
    { owner:arjunId,model:4,vin:'SYNTHETICVIN00004',nickname:'XUV' }
  ];
  const vehicleIds = [];
  for (const vehicle of vehicles) {
    const [existing] = await pool.execute('SELECT vehicle_id FROM ev_vehicle WHERE vin=?', [vehicle.vin]);
    if (existing[0]) vehicleIds.push(existing[0].vehicle_id);
    else {
      const [insert] = await pool.execute('INSERT INTO ev_vehicle(user_id,model_id,vin,nickname) VALUES(?,?,?,?)',
        [vehicle.owner,vehicle.model,vehicle.vin,vehicle.nickname]);
      vehicleIds.push(insert.insertId);
    }
  }

  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0,0,0,0);
  const network = [
    { port:1,station:1,tariff:1 }, { port:4,station:2,tariff:2 },
    { port:6,station:3,tariff:3 }, { port:8,station:4,tariff:4 }
  ];
  let sessionsCreated = 0;
  for (let n=0; n<20; n++) {
    const networkRow = network[n % network.length];
    const ownerIndex = n % 2;
    const ownerId = ownerIndex ? arjunId : mayaId;
    const vehicleId = ownerIndex ? vehicleIds[2 + (n % 2)] : vehicleIds[n % 2];
    const started = new Date(dayStart.getTime() - (n + 1) * 24 * 60 * 60 * 1000);
    started.setUTCHours(8,10,0,0);
    const ended = new Date(started.getTime() + 42 * 60 * 1000);
    const startAt = sqlDate(started);
    const endAt = sqlDate(ended);
    const [existing] = await pool.execute('SELECT booking_id FROM booking WHERE user_id=? AND port_id=? AND start_at=?',
      [ownerId,networkRow.port,startAt]);
    if (existing.length) continue;
    const [booking] = await pool.execute(
      `INSERT INTO booking(user_id,vehicle_id,port_id,start_at,end_at,status)
       VALUES(?,?,?,?,?,'CONFIRMED')`, [ownerId,vehicleId,networkRow.port,startAt,endAt]
    );
    const [session] = await pool.execute(
      `INSERT INTO charging_session(booking_id,user_id,vehicle_id,port_id,tariff_id,started_at,start_energy_kwh,status)
       VALUES(?,?,?,?,?,?,0,'ACTIVE')`,
      [booking.insertId,ownerId,vehicleId,networkRow.port,networkRow.tariff,startAt]
    );
    const finalKwh = 18 + (n % 7) * 2.5;
    const readingTimes = [started, new Date(started.getTime()+14*60000), new Date(started.getTime()+28*60000), ended];
    const values = [0, Number((finalKwh*0.32).toFixed(3)), Number((finalKwh*0.71).toFixed(3)), finalKwh];
    for (let i=0;i<readingTimes.length;i++) {
      await pool.execute('INSERT INTO meter_reading(session_id,reading_no,recorded_at,cumulative_kwh) VALUES(?,?,?,?)',
        [session.insertId,i+1,sqlDate(readingTimes[i]),values[i]]);
    }
    await pool.execute(`UPDATE charging_session SET ended_at=?,end_energy_kwh=?,status='COMPLETED' WHERE session_id=?`,
      [endAt,finalKwh,session.insertId]);
    await pool.execute("UPDATE booking SET status='COMPLETED' WHERE booking_id=?", [booking.insertId]);
    const [[tariff]] = await pool.execute('SELECT energy_rate_per_kwh,session_fee,currency FROM tariff WHERE tariff_id=?', [networkRow.tariff]);
    const energyAmount = Number((finalKwh * Number(tariff.energy_rate_per_kwh)).toFixed(2));
    const total = Number((energyAmount + Number(tariff.session_fee)).toFixed(2));
    const invoiceNo = `SEED-${String(session.insertId).padStart(6,'0')}`;
    const [invoice] = await pool.execute(
      `INSERT INTO invoice(session_id,invoice_number,currency,subtotal,tax_amount,total_amount,status)
       VALUES(?,?,?, ?,0,?,'PAID')`, [session.insertId,invoiceNo,tariff.currency,total,total]
    );
    await pool.execute(`INSERT INTO invoice_line(invoice_id,line_type,description,quantity,unit_price,amount)
      VALUES(?,'ENERGY',?,?,?,?)`, [invoice.insertId,`Energy delivery (${finalKwh} kWh)`,finalKwh,tariff.energy_rate_per_kwh,energyAmount]);
    if (Number(tariff.session_fee) > 0) await pool.execute(`INSERT INTO invoice_line(invoice_id,line_type,description,quantity,unit_price,amount)
      VALUES(?,'SESSION_FEE','Session fee',1,?,?)`, [invoice.insertId,tariff.session_fee,tariff.session_fee]);
    await pool.execute(`INSERT INTO payment(invoice_id,amount,currency,method,status,provider_reference,settled_at)
      VALUES(?,?,?,'UPI','SUCCEEDED',?,?)`, [invoice.insertId,total,tariff.currency,`SEED-PAY-${session.insertId}`,endAt]);
    sessionsCreated++;
  }

  const futureStart = new Date(dayStart);
  futureStart.setUTCHours(10,0,0,0);
  if (futureStart <= now) futureStart.setUTCDate(futureStart.getUTCDate()+1);
  const futureEnd = new Date(futureStart.getTime()+60*60*1000);
  const [future] = await pool.execute('SELECT booking_id FROM booking WHERE user_id=? AND port_id=2 AND start_at=?',
    [mayaId,sqlDate(futureStart)]);
  if (!future.length) await pool.execute(
    `INSERT INTO booking(user_id,vehicle_id,port_id,start_at,end_at,status) VALUES(?,?,2,?,?,'CONFIRMED')`,
    [mayaId,vehicleIds[0],sqlDate(futureStart),sqlDate(futureEnd)]
  );

  const [[ticketExists]] = await pool.execute('SELECT COUNT(*) AS total FROM maintenance_ticket WHERE port_id=7');
  if (!ticketExists.total) {
    await pool.execute(`INSERT INTO maintenance_ticket(port_id,reported_by,assigned_to,fault_category,description,priority,status,reported_at,due_at)
      VALUES(7,?,?, 'CONNECTOR_FAULT','Connector latch needs inspection','HIGH','IN_PROGRESS',UTC_TIMESTAMP(3)-INTERVAL 2 DAY,UTC_TIMESTAMP(3)+INTERVAL 1 DAY)`,
      [mayaId,technicianId]);
    await pool.execute("UPDATE charging_port SET operational_status='OUT_OF_SERVICE' WHERE port_id=7");
  }
  console.log(`Seed ready. ${demoUsers.length} demo accounts; ${demoHubs.length} pan-India simulated booking hubs; created ${sessionsCreated} completed sessions.`);
  console.log(`Demo password for all seeded accounts: ${demoPassword}`);
}

main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => pool.end());
