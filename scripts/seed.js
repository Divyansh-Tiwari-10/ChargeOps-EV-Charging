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

function sqlDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
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
  console.log(`Seed ready. ${demoUsers.length} demo accounts; created ${sessionsCreated} completed sessions.`);
  console.log(`Demo password for all seeded accounts: ${demoPassword}`);
}

main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => pool.end());
