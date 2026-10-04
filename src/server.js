import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, inTransaction } from './db.js';
import { allowRoles, requireAuth, signInToken } from './auth.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(here, '..', 'public')));

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const badRequest = message => Object.assign(new Error(message), { status: 400 });
const notFound = message => Object.assign(new Error(message), { status: 404 });
const conflict = message => Object.assign(new Error(message), { status: 409 });
const validDate = value => value && !Number.isNaN(new Date(value).getTime());
const dateSql = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
const placeCache = new Map();
const chargerCache = new Map();
let geocodeQueue = Promise.resolve();
let lastGeocodeRequestAt = 0;
const beeDataset = JSON.parse(gunzipSync(readFileSync(path.join(here, '..', 'data', 'india-charging-stations.json.gz'))).toString('utf8'));
const beeStations = beeDataset.stations;
const distanceKm = (a, b) => {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
};
const cacheRead = (cache, key) => {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  return null;
};
const cacheWrite = (cache, key, value, ttlMs) => cache.set(key, { value, expiresAt: Date.now() + ttlMs });

async function geocodePlace(query) {
  const key = query.trim().toLowerCase();
  const cached = cacheRead(placeCache, key);
  if (cached) return cached;
  const task = geocodeQueue.then(async () => {
    const remaining = 1100 - (Date.now() - lastGeocodeRequestAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    lastGeocodeRequestAt = Date.now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', countrycodes: 'in' }).toString();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ChargeOpsStudentProject/1.0 (https://github.com/Divyansh-Tiwari-10/ChargeOps-EV-Charging)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw Object.assign(new Error('Place search is temporarily unavailable. You can use your device location instead.'), { status: 503 });
    const rows = await response.json();
    if (!rows.length) throw notFound('Could not find that place. Try a nearby city or use your device location.');
    const result = { latitude: Number(rows[0].lat), longitude: Number(rows[0].lon), display_name: rows[0].display_name };
    cacheWrite(placeCache, key, result, 30 * 24 * 60 * 60 * 1000);
    return result;
  });
  geocodeQueue = task.catch(() => {});
  return task;
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT 1 AS database_connected, UTC_TIMESTAMP(3) AS server_time');
  res.json({ status: 'ok', database: rows[0] });
}));

app.get('/api/map/geocode', asyncRoute(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2 || query.length > 120) throw badRequest('Enter a place name between 2 and 120 characters.');
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ place: await geocodePlace(query) });
}));

app.get('/api/map/public-chargers', asyncRoute(async (req, res) => {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  const radius = Number(req.query.radius || 5000);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(radius) || radius < 500 || radius > 10000) {
    throw badRequest('Provide valid coordinates and a search radius between 500 m and 10 km.');
  }
  const cacheKey = [latitude.toFixed(3), longitude.toFixed(3), Math.round(radius / 500) * 500].join(',');
  let result = cacheRead(chargerCache, cacheKey);
  if (!result) {
    const query = '[out:json][timeout:20];nwr(around:' + Math.round(radius) + ',' + latitude + ',' + longitude + ')[amenity=charging_station];out center tags;';
    let payload = { elements: [] }, overpassUnavailable = false;
    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'ChargeOpsStudentProject/1.0 (https://github.com/Divyansh-Tiwari-10/ChargeOps-EV-Charging)'
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw new Error('Overpass returned HTTP ' + response.status);
      payload = await response.json();
    } catch {
      overpassUnavailable = true;
    }
    const elements = (payload?.elements || []).map(element => {
      const tags = element.tags || {};
      const point = element.type === 'node' ? element : element.center;
      if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) return null;
      const sockets = Object.keys(tags).filter(key => key.startsWith('socket:') && !key.endsWith(':output') && !key.endsWith(':current'));
      const connectorNames = [...new Set(sockets.map(key => {
        const socket = key.slice(7);
        if (socket === 'type2_combo' || socket === 'ccs') return 'CCS / CCS2';
        if (socket === 'type2' || socket === 'type2_cable') return 'Type 2 AC';
        if (socket === 'chademo') return 'CHAdeMO';
        if (socket.startsWith('tesla')) return 'Tesla';
        return socket.replaceAll('_', ' ');
      }))];
      const location = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'], tags['addr:city'] || tags['addr:town']].filter(Boolean).join(', ');
      return {
        osm_id: element.type + '/' + element.id,
        map_id: element.type + '/' + element.id,
        source: 'OpenStreetMap',
        source_label: 'OpenStreetMap community record',
        source_url: 'https://www.openstreetmap.org/' + element.type + '/' + element.id,
        source_date: null,
        availability_note: 'Live availability and pricing are not provided by map data.',
        name: tags.name || tags.operator || 'Public charging station',
        operator: tags.operator || tags.network || null,
        latitude: Number(point.lat),
        longitude: Number(point.lon),
        address: location || null,
        connectors: connectorNames,
        socket_details: sockets.map(key => key.slice(7).replaceAll('_', ' ') + (tags[key] ? ' × ' + tags[key] : '')),
        power: tags.capacity || tags['capacity:charging'] || null,
        opening_hours: tags.opening_hours || null,
        access: tags.access || null,
        fee: tags.fee || null,
        status: tags.operational_status || tags.status || null,
        website: tags.website || null,
        osm_url: 'https://www.openstreetmap.org/' + element.type + '/' + element.id
      };
    }).filter(Boolean);
    const officialSnapshot = beeStations.filter(station => distanceKm({ latitude, longitude }, station) <= radius / 1000);
    if (overpassUnavailable && !officialSnapshot.length) throw Object.assign(new Error('The community charger map is busy. Try again shortly.'), { status: 503 });
    const combined = [...elements];
    for (const station of officialSnapshot) {
      const duplicate = combined.find(mapped => distanceKm(mapped, station) < 0.08);
      if (duplicate) {
        duplicate.connectors = [...new Set([...duplicate.connectors, ...station.connectors])];
        duplicate.connector_details = [...new Set([...(duplicate.connector_details || []), ...station.connector_details])];
        duplicate.source_label += ' · BEE snapshot also lists this location';
        duplicate.source_url = station.source_url;
        duplicate.source_date = station.source_date;
        duplicate.availability_note = station.availability_note;
      } else combined.push(station);
    }
    result = { stations: combined, source_timestamp: payload?.osm3s?.timestamp_osm_base || null, snapshot_date:officialSnapshot.length ? beeDataset.source_date : null, national_dataset_count:beeDataset.station_count, overpass_unavailable:overpassUnavailable };
    cacheWrite(chargerCache, cacheKey, result, 10 * 60 * 1000);
  }
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ ...result, center: { latitude, longitude }, radius_m: Math.round(radius), source: 'OpenStreetMap / Overpass and BEE public-station snapshot' });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { email, password, displayName, phone } = req.body || {};
  if (!email || !password || !displayName || String(password).length < 8) {
    throw badRequest('Email, display name, and a password of at least 8 characters are required.');
  }
  const passwordHash = await bcrypt.hash(String(password), 12);
  const result = await inTransaction(async connection => {
    const [insert] = await connection.execute(
      'INSERT INTO user_account(email,password_hash,display_name,phone) VALUES(?,?,?,?)',
      [String(email).trim().toLowerCase(), passwordHash, String(displayName).trim(), phone || null]
    );
    const [[role]] = await connection.execute("SELECT role_id FROM app_role WHERE role_name='CUSTOMER'");
    if (!role) throw new Error('CUSTOMER role is missing. Apply sql/schema.sql and sql/seed.sql first.');
    await connection.execute('INSERT INTO user_role(user_id,role_id) VALUES(?,?)', [insert.insertId, role.role_id]);
    await connection.execute('INSERT INTO wallet(user_id,currency) VALUES(?,?)', [insert.insertId, 'INR']);
    return { user_id: insert.insertId, email, display_name: displayName, roles: ['CUSTOMER'] };
  });
  res.status(201).json({ token: signInToken(result), user: result });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('Email and password are required.');
  const [rows] = await pool.execute(
    `SELECT u.user_id,u.email,u.display_name,u.password_hash,u.is_active,
            GROUP_CONCAT(r.role_name ORDER BY r.role_name) AS role_list
     FROM user_account u LEFT JOIN user_role ur ON ur.user_id=u.user_id
     LEFT JOIN app_role r ON r.role_id=ur.role_id
     WHERE u.email=? GROUP BY u.user_id`, [String(email).trim().toLowerCase()]
  );
  const account = rows[0];
  if (!account?.is_active || !(await bcrypt.compare(String(password), account.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const user = { user_id: account.user_id, email: account.email, display_name: account.display_name,
    roles: account.role_list ? account.role_list.split(',') : [] };
  res.json({ token: signInToken(user), user });
}));

app.get('/api/stations', asyncRoute(async (req, res) => {
  const { city, connector, from, to } = req.query;
  if (Boolean(from) !== Boolean(to) || (from && (!validDate(from) || !validDate(to) || new Date(to) <= new Date(from)))) {
    throw badRequest('Provide a valid time interval with end after start.');
  }
  const params = [];
  const filters = ['s.is_active=TRUE'];
  if (city) { filters.push('s.city=?'); params.push(String(city)); }
  const [stations] = await pool.execute(
    `SELECT s.station_id,s.name,s.address,s.city,s.region,s.latitude,s.longitude,
            (SELECT t.energy_rate_per_kwh FROM tariff t WHERE t.station_id=s.station_id
             AND t.effective_from<=UTC_TIMESTAMP(3) AND (t.effective_to IS NULL OR t.effective_to>UTC_TIMESTAMP(3))
             ORDER BY t.effective_from DESC LIMIT 1) AS energy_rate_per_kwh,
            COUNT(DISTINCT p.port_id) AS port_count,
            SUM(p.operational_status='OPERATIONAL') AS operational_ports,
            SUM(p.operational_status='OPERATIONAL' AND
                NOT EXISTS (
                  SELECT 1 FROM booking b WHERE b.port_id=p.port_id AND b.status='CONFIRMED'
                  AND b.start_at < COALESCE(?,UTC_TIMESTAMP(3))
                  AND b.end_at > COALESCE(?,UTC_TIMESTAMP(3))
                ) AND NOT EXISTS (
                  SELECT 1 FROM charging_session cs WHERE cs.port_id=p.port_id AND cs.status='ACTIVE'
                )) AS available_ports
     FROM charging_station s LEFT JOIN charging_port p ON p.station_id=s.station_id
     WHERE ${filters.join(' AND ')} GROUP BY s.station_id ORDER BY s.city,s.name`,
    [to ? dateSql(to) : null, from ? dateSql(from) : null, ...params]
  );
  res.json({ stations: connector ? await filterStationPorts(stations, connector, from, to) : stations });
}));

async function filterStationPorts(stations, connector, from, to) {
  if (!stations.length) return [];
  const [ports] = await pool.execute(
    `SELECT p.station_id,p.port_id,p.port_code,p.max_power_kw,p.operational_status,
            EXISTS(SELECT 1 FROM booking b WHERE b.port_id=p.port_id AND b.status='CONFIRMED'
                   AND b.start_at < COALESCE(?,UTC_TIMESTAMP(3))
                   AND b.end_at > COALESCE(?,UTC_TIMESTAMP(3))) AS is_booked,
            EXISTS(SELECT 1 FROM charging_session cs WHERE cs.port_id=p.port_id AND cs.status='ACTIVE') AS is_active
     FROM charging_port p JOIN port_connector pc ON pc.port_id=p.port_id
     JOIN connector_type c ON c.connector_id=pc.connector_id
     WHERE c.connector_name=?`,
    [to ? dateSql(to) : null, from ? dateSql(from) : null, connector]
  );
  const eligible = new Set(ports.filter(p => p.operational_status === 'OPERATIONAL' && !p.is_booked && !p.is_active)
    .map(p => Number(p.station_id)));
  return stations.map(s => ({ ...s, available_ports: ports.filter(p => Number(p.station_id) === Number(s.station_id) &&
    p.operational_status === 'OPERATIONAL' && !p.is_booked && !p.is_active).length })).filter(s => eligible.has(Number(s.station_id)));
}

app.get('/api/stations/:stationId', asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT s.station_id,s.name,s.address,s.city,s.region,s.latitude,s.longitude,s.site_capacity_kw,
            (SELECT t.energy_rate_per_kwh FROM tariff t WHERE t.station_id=s.station_id
             AND t.effective_from<=UTC_TIMESTAMP(3) AND (t.effective_to IS NULL OR t.effective_to>UTC_TIMESTAMP(3))
             ORDER BY t.effective_from DESC LIMIT 1) AS energy_rate_per_kwh,
            (SELECT t.session_fee FROM tariff t WHERE t.station_id=s.station_id
             AND t.effective_from<=UTC_TIMESTAMP(3) AND (t.effective_to IS NULL OR t.effective_to>UTC_TIMESTAMP(3))
             ORDER BY t.effective_from DESC LIMIT 1) AS session_fee,
            p.port_id,p.port_code,p.max_power_kw,p.operational_status,
            GROUP_CONCAT(DISTINCT c.connector_name ORDER BY c.connector_name) AS connectors
     FROM charging_station s LEFT JOIN charging_port p ON p.station_id=s.station_id
     LEFT JOIN port_connector pc ON pc.port_id=p.port_id LEFT JOIN connector_type c ON c.connector_id=pc.connector_id
     WHERE s.station_id=? GROUP BY s.station_id,p.port_id ORDER BY p.port_code`, [req.params.stationId]
  );
  if (!rows.length) throw notFound('Station was not found.');
  const first = rows[0];
  res.json({ station: { station_id:first.station_id,name:first.name,address:first.address,city:first.city,
    region:first.region,latitude:first.latitude,longitude:first.longitude,site_capacity_kw:first.site_capacity_kw,
    energy_rate_per_kwh:first.energy_rate_per_kwh,session_fee:first.session_fee,
    ports:rows.filter(r => r.port_id).map(r => ({ port_id:r.port_id,port_code:r.port_code,
      max_power_kw:r.max_power_kw,operational_status:r.operational_status,
      connectors:r.connectors ? r.connectors.split(',') : [] })) } });
}));

app.get('/api/ports/:portId/availability', asyncRoute(async (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to) || new Date(to) <= new Date(from)) throw badRequest('A valid from/to interval is required.');
  const [rows] = await pool.execute(
    `SELECT p.port_id,p.port_code,p.max_power_kw,p.operational_status,s.station_id,s.name AS station_name,
       NOT EXISTS(SELECT 1 FROM booking b WHERE b.port_id=p.port_id AND b.status='CONFIRMED'
                  AND b.start_at < ? AND b.end_at > ?) AND
       NOT EXISTS(SELECT 1 FROM charging_session cs WHERE cs.port_id=p.port_id AND cs.status='ACTIVE') AS available
     FROM charging_port p JOIN charging_station s ON s.station_id=p.station_id WHERE p.port_id=?`,
    [dateSql(to), dateSql(from), req.params.portId]
  );
  if (!rows.length) throw notFound('Port was not found.');
  res.json({ ...rows[0], available: Boolean(rows[0].available) && rows[0].operational_status === 'OPERATIONAL' });
}));

app.get('/api/vehicles', requireAuth, asyncRoute(async (req, res) => {
  const [vehicles] = await pool.execute(
    `SELECT v.vehicle_id,v.vin,v.nickname,m.make,m.model,m.model_year,m.battery_kwh,
            GROUP_CONCAT(DISTINCT c.connector_name ORDER BY c.connector_name) AS connector_names
     FROM ev_vehicle v JOIN vehicle_model m ON m.model_id=v.model_id
     LEFT JOIN vehicle_model_connector vmc ON vmc.model_id=m.model_id
     LEFT JOIN connector_type c ON c.connector_id=vmc.connector_id
     WHERE v.user_id=? GROUP BY v.vehicle_id ORDER BY v.vehicle_id`, [req.user.user_id]
  );
  res.json({ vehicles });
}));

app.post('/api/vehicles', requireAuth, asyncRoute(async (req, res) => {
  const { modelId, vin, nickname } = req.body || {};
  if (!modelId || !vin || String(vin).length !== 17) throw badRequest('A vehicle model and 17-character VIN are required.');
  const [result] = await pool.execute('INSERT INTO ev_vehicle(user_id,model_id,vin,nickname) VALUES(?,?,?,?)',
    [req.user.user_id, modelId, String(vin).toUpperCase(), nickname || null]);
  res.status(201).json({ vehicle_id: result.insertId });
}));

app.get('/api/vehicle-models', asyncRoute(async (_req, res) => {
  const [models] = await pool.query('SELECT model_id,make,model,model_year,battery_kwh FROM vehicle_model ORDER BY make,model');
  res.json({ models });
}));

app.post('/api/bookings', requireAuth, asyncRoute(async (req, res) => {
  const { vehicleId, portId, startAt, endAt } = req.body || {};
  if (!vehicleId || !portId || !validDate(startAt) || !validDate(endAt) || new Date(endAt) <= new Date(startAt)) {
    throw badRequest('Vehicle, port, and a valid start/end interval are required.');
  }
  const bookingId = await inTransaction(async c => {
    const [ports] = await c.execute('SELECT port_id,operational_status FROM charging_port WHERE port_id=? FOR UPDATE', [portId]);
    if (!ports.length) throw notFound('Port was not found.');
    if (ports[0].operational_status !== 'OPERATIONAL') throw conflict('This port is out of service.');
    const [[vehicle]] = await c.execute('SELECT vehicle_id FROM ev_vehicle WHERE vehicle_id=? AND user_id=?', [vehicleId, req.user.user_id]);
    if (!vehicle) throw badRequest('The selected EV does not belong to your account.');
    const [compatible] = await c.execute(
      `SELECT 1 FROM ev_vehicle v JOIN vehicle_model_connector vmc ON vmc.model_id=v.model_id
       JOIN port_connector pc ON pc.connector_id=vmc.connector_id AND pc.port_id=?
       WHERE v.vehicle_id=? LIMIT 1`, [portId, vehicleId]
    );
    if (!compatible.length) throw conflict('This EV does not support a connector fitted to the selected port.');
    const [conflicts] = await c.execute(
      `SELECT booking_id FROM booking WHERE port_id=? AND status='CONFIRMED'
       AND start_at < ? AND end_at > ? LIMIT 1`, [portId, dateSql(endAt), dateSql(startAt)]
    );
    if (conflicts.length) throw conflict('Another booking overlaps this time on the selected port.');
    const [active] = await c.execute("SELECT session_id FROM charging_session WHERE port_id=? AND status='ACTIVE' LIMIT 1", [portId]);
    if (active.length) throw conflict('This port currently has an active charging session.');
    const [insert] = await c.execute(
      `INSERT INTO booking(user_id,vehicle_id,port_id,start_at,end_at,status)
       VALUES(?,?,?,?,?,'CONFIRMED')`, [req.user.user_id, vehicleId, portId, dateSql(startAt), dateSql(endAt)]
    );
    await c.execute(`INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
      VALUES(?,'BOOK','booking',?,JSON_OBJECT('port_id',?,'start_at',?,'end_at',?))`,
      [req.user.user_id, String(insert.insertId), portId, dateSql(startAt), dateSql(endAt)]);
    return insert.insertId;
  });
  res.status(201).json({ booking_id: bookingId, status: 'CONFIRMED' });
}));

app.get('/api/bookings', requireAuth, asyncRoute(async (req, res) => {
  const [bookings] = await pool.execute(
    `SELECT b.booking_id,b.start_at,b.end_at,b.status,s.station_id,s.name AS station_name,
            p.port_id,p.port_code,v.vehicle_id,v.nickname,cs.session_id,cs.status AS session_status,
            i.invoice_id,i.total_amount,i.status AS invoice_status,
            CASE WHEN cs.status='COMPLETED' THEN ROUND(cs.end_energy_kwh-cs.start_energy_kwh,3) ELSE 0 END AS energy_kwh,
            (SELECT mr.cumulative_kwh FROM meter_reading mr WHERE mr.session_id=cs.session_id
             ORDER BY mr.reading_no DESC LIMIT 1) AS meter_value
     FROM booking b JOIN charging_port p ON p.port_id=b.port_id
     JOIN charging_station s ON s.station_id=p.station_id JOIN ev_vehicle v ON v.vehicle_id=b.vehicle_id
     LEFT JOIN charging_session cs ON cs.booking_id=b.booking_id LEFT JOIN invoice i ON i.session_id=cs.session_id
     WHERE b.user_id=? ORDER BY b.start_at DESC LIMIT 100`, [req.user.user_id]
  );
  res.json({ bookings });
}));

app.delete('/api/bookings/:bookingId', requireAuth, asyncRoute(async (req, res) => {
  await inTransaction(async c => {
    const [rows] = await c.execute('SELECT booking_id,status,start_at FROM booking WHERE booking_id=? AND user_id=? FOR UPDATE',
      [req.params.bookingId, req.user.user_id]);
    if (!rows.length) throw notFound('Booking was not found.');
    if (rows[0].status !== 'CONFIRMED' || new Date(rows[0].start_at) <= new Date()) throw conflict('This booking can no longer be cancelled.');
    await c.execute("UPDATE booking SET status='CANCELLED',cancelled_at=UTC_TIMESTAMP(3) WHERE booking_id=?", [req.params.bookingId]);
    await c.execute(`INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
      VALUES(?,'CANCEL','booking',?,JSON_OBJECT('status','CANCELLED'))`, [req.user.user_id, String(req.params.bookingId)]);
  });
  res.json({ booking_id: Number(req.params.bookingId), status: 'CANCELLED' });
}));

app.post('/api/sessions', requireAuth, allowRoles('CUSTOMER','STATION_OPERATOR','ADMIN'), asyncRoute(async (req, res) => {
  const { bookingId } = req.body || {};
  if (!bookingId) throw badRequest('bookingId is required to start a reserved session.');
  const sessionId = await inTransaction(async c => {
    const [candidate] = await c.execute('SELECT port_id FROM booking WHERE booking_id=?', [bookingId]);
    if (!candidate.length) throw notFound('Booking was not found.');
    await c.execute('SELECT port_id FROM charging_port WHERE port_id=? FOR UPDATE', [candidate[0].port_id]);
    const [[booking]] = await c.execute(
      `SELECT b.*,p.operational_status,p.station_id FROM booking b JOIN charging_port p ON p.port_id=b.port_id
       WHERE b.booking_id=? FOR UPDATE`, [bookingId]
    );
    if (!booking) throw notFound('Booking was not found.');
    if (booking.user_id !== req.user.user_id && !req.user.roles.some(r => ['STATION_OPERATOR','ADMIN'].includes(r))) {
      throw Object.assign(new Error('You cannot start another user’s booking.'), { status: 403 });
    }
    if (booking.status !== 'CONFIRMED' || booking.operational_status !== 'OPERATIONAL') throw conflict('Booking or port is not ready to start.');
    const now = new Date();
    if (now < new Date(booking.start_at) || now > new Date(booking.end_at)) throw conflict('The current time is outside the booking window.');
    const [existing] = await c.execute("SELECT session_id FROM charging_session WHERE port_id=? AND status='ACTIVE' FOR UPDATE", [booking.port_id]);
    if (existing.length) throw conflict('Port already has an active session.');
    const [tariffs] = await c.execute(
      `SELECT tariff_id FROM tariff WHERE station_id=? AND effective_from<=UTC_TIMESTAMP(3)
       AND (effective_to IS NULL OR effective_to>UTC_TIMESTAMP(3)) ORDER BY effective_from DESC LIMIT 1`, [booking.station_id]
    );
    if (!tariffs.length) throw conflict('No active tariff is configured for this station.');
    const [insert] = await c.execute(
      `INSERT INTO charging_session(booking_id,user_id,vehicle_id,port_id,tariff_id,started_at,start_energy_kwh,status)
       VALUES(?,?,?,?,?,UTC_TIMESTAMP(3),0,'ACTIVE')`,
      [booking.booking_id, booking.user_id, booking.vehicle_id, booking.port_id, tariffs[0].tariff_id]
    );
    await c.execute(`INSERT INTO meter_reading(session_id,reading_no,recorded_at,cumulative_kwh)
                     VALUES(?,1,UTC_TIMESTAMP(3),0)`, [insert.insertId]);
    return insert.insertId;
  });
  res.status(201).json({ session_id: sessionId, status: 'ACTIVE' });
}));

app.post('/api/sessions/:sessionId/meter-readings', requireAuth, allowRoles('CUSTOMER','STATION_OPERATOR','ADMIN'), asyncRoute(async (req, res) => {
  const { cumulativeKwh } = req.body || {};
  if (!Number.isFinite(Number(cumulativeKwh)) || Number(cumulativeKwh) < 0) throw badRequest('cumulativeKwh must be a non-negative number.');
  const reading = await inTransaction(async c => {
    const [sessions] = await c.execute('SELECT session_id,user_id,status FROM charging_session WHERE session_id=? FOR UPDATE', [req.params.sessionId]);
    if (!sessions.length) throw notFound('Session was not found.');
    const s = sessions[0];
    if (s.user_id !== req.user.user_id && !req.user.roles.some(r => ['STATION_OPERATOR','ADMIN'].includes(r))) {
      throw Object.assign(new Error('You cannot write readings to another user’s session.'), { status: 403 });
    }
    if (s.status !== 'ACTIVE') throw conflict('Meter readings are accepted only during active sessions.');
    const [latest] = await c.execute('SELECT reading_no,cumulative_kwh FROM meter_reading WHERE session_id=? ORDER BY reading_no DESC LIMIT 1', [s.session_id]);
    const value = Number(cumulativeKwh);
    if (latest.length && value <= Number(latest[0].cumulative_kwh)) throw badRequest('Meter value must increase from the previous reading.');
    const readingNo = latest.length ? latest[0].reading_no + 1 : 1;
    await c.execute('INSERT INTO meter_reading(session_id,reading_no,recorded_at,cumulative_kwh) VALUES(?, ?, UTC_TIMESTAMP(3), ?)',
      [s.session_id, readingNo, value]);
    return { session_id: s.session_id, reading_no: readingNo, cumulative_kwh: value };
  });
  res.status(201).json(reading);
}));

app.post('/api/sessions/:sessionId/complete', requireAuth, allowRoles('CUSTOMER','STATION_OPERATOR','ADMIN'), asyncRoute(async (req, res) => {
  const result = await inTransaction(async c => {
    const [rows] = await c.execute(
      `SELECT cs.*,t.energy_rate_per_kwh,t.session_fee,t.currency AS tariff_currency
       FROM charging_session cs JOIN tariff t ON t.tariff_id=cs.tariff_id
       WHERE cs.session_id=? FOR UPDATE`, [req.params.sessionId]
    );
    if (!rows.length) throw notFound('Session was not found.');
    const session = rows[0];
    if (session.user_id !== req.user.user_id && !req.user.roles.some(r => ['STATION_OPERATOR','ADMIN'].includes(r))) {
      throw Object.assign(new Error('You cannot complete another user’s session.'), { status: 403 });
    }
    if (session.status !== 'ACTIVE') throw conflict('Session is already closed.');
    const [readings] = await c.execute('SELECT cumulative_kwh FROM meter_reading WHERE session_id=? ORDER BY reading_no DESC LIMIT 1', [session.session_id]);
    if (!readings.length || Number(readings[0].cumulative_kwh) <= Number(session.start_energy_kwh)) throw badRequest('A final meter reading above the start reading is required.');
    const finalKwh = Number(readings[0].cumulative_kwh);
    const energyKwh = Number((finalKwh - Number(session.start_energy_kwh)).toFixed(3));
    const [amounts] = await c.execute('SELECT ROUND(? * ?,2) AS energy_amount, ROUND(? + ROUND(? * ?,2),2) AS subtotal',
      [energyKwh, session.energy_rate_per_kwh, Number(session.session_fee), energyKwh, session.energy_rate_per_kwh]);
    const subtotal = Number(amounts[0].subtotal);
    const invoiceNumber = `EV-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    await c.execute(`UPDATE charging_session SET ended_at=UTC_TIMESTAMP(3),end_energy_kwh=?,status='COMPLETED' WHERE session_id=?`, [finalKwh, session.session_id]);
    if (session.booking_id) await c.execute("UPDATE booking SET status='COMPLETED' WHERE booking_id=?", [session.booking_id]);
    const [invoice] = await c.execute(
      `INSERT INTO invoice(session_id,invoice_number,currency,subtotal,tax_amount,total_amount,status)
       VALUES(?,?,?, ?,0,?,'UNPAID')`, [session.session_id, invoiceNumber, session.tariff_currency, subtotal, subtotal]
    );
    await c.execute(`INSERT INTO invoice_line(invoice_id,line_type,description,quantity,unit_price,amount)
      VALUES(?,'ENERGY',?,?,?,?)`, [invoice.insertId, `Charging energy (${energyKwh} kWh)`, energyKwh, session.energy_rate_per_kwh, amounts[0].energy_amount]);
    if (Number(session.session_fee) > 0) await c.execute(`INSERT INTO invoice_line(invoice_id,line_type,description,quantity,unit_price,amount)
      VALUES(?,'SESSION_FEE','Session fee',1,?,?)`, [invoice.insertId, session.session_fee, session.session_fee]);
    return { session_id: session.session_id, energy_kwh: energyKwh, invoice_id: invoice.insertId, invoice_number: invoiceNumber, total_amount: subtotal };
  });
  res.json(result);
}));

app.post('/api/invoices/:invoiceId/payments', requireAuth, allowRoles('CUSTOMER','FINANCE','ADMIN'), asyncRoute(async (req, res) => {
  const { method, outcome = 'SUCCEEDED' } = req.body || {};
  const allowedMethods = ['CARD','UPI','WALLET','CASH_SIMULATED'];
  if (!allowedMethods.includes(method) || !['SUCCEEDED','FAILED'].includes(outcome)) throw badRequest('Choose a supported method and SUCCEEDED or FAILED simulated outcome.');
  const payment = await inTransaction(async c => {
    const [rows] = await c.execute(
      `SELECT i.*,cs.user_id FROM invoice i JOIN charging_session cs ON cs.session_id=i.session_id
       WHERE i.invoice_id=? FOR UPDATE`, [req.params.invoiceId]
    );
    if (!rows.length) throw notFound('Invoice was not found.');
    const invoice = rows[0];
    if (invoice.user_id !== req.user.user_id && !req.user.roles.some(r => ['FINANCE','ADMIN'].includes(r))) {
      throw Object.assign(new Error('You cannot pay another user’s invoice.'), { status: 403 });
    }
    if (invoice.status === 'PAID' || invoice.status === 'VOID') throw conflict('Invoice is not payable.');
    const [[settled]] = await c.execute("SELECT COALESCE(SUM(amount),0) AS amount FROM payment WHERE invoice_id=? AND status='SUCCEEDED'", [invoice.invoice_id]);
    const remaining = Number((Number(invoice.total_amount) - Number(settled.amount)).toFixed(2));
    if (remaining <= 0) throw conflict('Invoice is already settled.');
    if (method === 'WALLET') {
      const [wallets] = await c.execute('SELECT wallet_id FROM wallet WHERE user_id=? AND currency=? FOR UPDATE', [invoice.user_id, invoice.currency]);
      if (!wallets.length) throw conflict('No matching currency wallet exists.');
      const [[balance]] = await c.execute(`SELECT COALESCE(SUM(CASE WHEN txn_type IN ('TOP_UP','REFUND') THEN amount ELSE -amount END),0) AS amount
        FROM wallet_transaction WHERE wallet_id=?`, [wallets[0].wallet_id]);
      if (Number(balance.amount) < remaining && outcome === 'SUCCEEDED') throw conflict('Wallet balance is too low.');
    }
    const [insert] = await c.execute(`INSERT INTO payment(invoice_id,amount,currency,method,status,provider_reference,settled_at)
      VALUES(?,?,?,?,?,?,IF(?='SUCCEEDED',UTC_TIMESTAMP(3),NULL))`,
      [invoice.invoice_id, remaining, invoice.currency, method, outcome, `SIM-${randomUUID()}`, outcome]);
    if (method === 'WALLET' && outcome === 'SUCCEEDED') {
      const [[wallet]] = await c.execute('SELECT wallet_id FROM wallet WHERE user_id=? AND currency=?', [invoice.user_id, invoice.currency]);
      await c.execute(`INSERT INTO wallet_transaction(wallet_id,payment_id,idempotency_key,txn_type,amount)
        VALUES(?,?,?,'CHARGE',?)`, [wallet.wallet_id, insert.insertId, `payment-${insert.insertId}`, remaining]);
    }
    const totalPaid = Number(settled.amount) + (outcome === 'SUCCEEDED' ? remaining : 0);
    const nextStatus = totalPaid >= Number(invoice.total_amount) ? 'PAID' : totalPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    if (outcome === 'SUCCEEDED') await c.execute('UPDATE invoice SET status=? WHERE invoice_id=?', [nextStatus, invoice.invoice_id]);
    return { payment_id: insert.insertId, status: outcome, invoice_status: outcome === 'SUCCEEDED' ? nextStatus : invoice.status, amount: remaining };
  });
  res.status(201).json(payment);
}));

app.post('/api/ports/:portId/maintenance', requireAuth, asyncRoute(async (req, res) => {
  const { category, description, priority = 'NORMAL' } = req.body || {};
  if (!category || !description) throw badRequest('Fault category and description are required.');
  const ticketId = await inTransaction(async c => {
    const [ports] = await c.execute('SELECT port_id FROM charging_port WHERE port_id=? FOR UPDATE', [req.params.portId]);
    if (!ports.length) throw notFound('Port was not found.');
    const [insert] = await c.execute(`INSERT INTO maintenance_ticket(port_id,reported_by,fault_category,description,priority)
      VALUES(?,?,?,?,?)`, [req.params.portId, req.user.user_id, category, description, priority]);
    await c.execute("UPDATE charging_port SET operational_status='OUT_OF_SERVICE' WHERE port_id=?", [req.params.portId]);
    return insert.insertId;
  });
  res.status(201).json({ ticket_id: ticketId, status: 'OPEN', port_status: 'OUT_OF_SERVICE' });
}));

app.get('/api/maintenance', requireAuth, allowRoles('TECHNICIAN','STATION_OPERATOR','ADMIN'), asyncRoute(async (_req, res) => {
  const [tickets] = await pool.query(`SELECT m.ticket_id,m.port_id,m.fault_category,m.description,m.priority,m.status,m.reported_at,m.due_at,
      s.name AS station_name,p.port_code,u.display_name AS technician
    FROM maintenance_ticket m JOIN charging_port p ON p.port_id=m.port_id
    JOIN charging_station s ON s.station_id=p.station_id LEFT JOIN user_account u ON u.user_id=m.assigned_to
    ORDER BY FIELD(m.status,'OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'),m.due_at`);
  res.json({ tickets });
}));

app.patch('/api/maintenance/:ticketId/resolve', requireAuth, allowRoles('TECHNICIAN','STATION_OPERATOR','ADMIN'), asyncRoute(async (req, res) => {
  await inTransaction(async c => {
    const [rows] = await c.execute('SELECT * FROM maintenance_ticket WHERE ticket_id=? FOR UPDATE', [req.params.ticketId]);
    if (!rows.length) throw notFound('Ticket was not found.');
    const ticket = rows[0];
    await c.execute("UPDATE maintenance_ticket SET status='RESOLVED',resolved_at=UTC_TIMESTAMP(3),assigned_to=COALESCE(assigned_to,?) WHERE ticket_id=?",
      [req.user.user_id, ticket.ticket_id]);
    const [open] = await c.execute(`SELECT ticket_id FROM maintenance_ticket WHERE port_id=? AND ticket_id<>?
      AND status IN ('OPEN','ASSIGNED','IN_PROGRESS') FOR UPDATE`, [ticket.port_id, ticket.ticket_id]);
    if (!open.length) await c.execute("UPDATE charging_port SET operational_status='OPERATIONAL' WHERE port_id=? AND operational_status='OUT_OF_SERVICE'", [ticket.port_id]);
    await c.execute(`INSERT INTO audit_log(actor_user_id,action_name,entity_name,entity_key,after_data)
      VALUES(?,'RESOLVE','maintenance_ticket',?,JSON_OBJECT('status','RESOLVED'))`, [req.user.user_id, String(ticket.ticket_id)]);
  });
  res.json({ ticket_id: Number(req.params.ticketId), status: 'RESOLVED' });
}));

app.get('/api/analytics/energy', requireAuth, allowRoles('STATION_OPERATOR','FINANCE','ADMIN'), asyncRoute(async (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to) || new Date(to) <= new Date(from)) throw badRequest('A valid from/to interval is required.');
  const [rows] = await pool.execute(`SELECT s.station_id,s.name,DATE(cs.started_at) AS service_date,
      COUNT(*) AS sessions,ROUND(SUM(cs.end_energy_kwh-cs.start_energy_kwh),3) AS energy_kwh
    FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
    JOIN charging_station s ON s.station_id=p.station_id
    WHERE cs.status='COMPLETED' AND cs.started_at>=? AND cs.started_at<?
    GROUP BY s.station_id,s.name,DATE(cs.started_at) ORDER BY service_date,s.name`, [dateSql(from), dateSql(to)]);
  res.json({ rows });
}));

app.get('/api/analytics/station-ranking', requireAuth, allowRoles('STATION_OPERATOR','FINANCE','ADMIN'), asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`WITH monthly AS (
    SELECT s.station_id,s.name,DATE_FORMAT(cs.started_at,'%Y-%m-01') AS month_start,
           SUM(cs.end_energy_kwh-cs.start_energy_kwh) AS energy_kwh
    FROM charging_session cs JOIN charging_port p ON p.port_id=cs.port_id
    JOIN charging_station s ON s.station_id=p.station_id
    WHERE cs.status='COMPLETED' GROUP BY s.station_id,s.name,DATE_FORMAT(cs.started_at,'%Y-%m-01')
  ) SELECT *,RANK() OVER(PARTITION BY month_start ORDER BY energy_kwh DESC) AS energy_rank
    FROM monthly ORDER BY month_start,energy_rank`);
  res.json({ rows });
}));

app.get('/api/me', requireAuth, (req, res) => {
  const { user_id, email, display_name, roles } = req.user;
  res.json({ user: { user_id, email, display_name, roles } });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route was not found.' }));
app.use((error, _req, res, _next) => {
  if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A record with that unique value already exists.' });
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'A referenced record does not exist.' });
  if (error.code === 'ER_SIGNAL_EXCEPTION') return res.status(409).json({ error: error.sqlMessage || 'A database business rule rejected this operation.' });
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'Unexpected server error.' : error.message });
});

app.listen(port, () => console.log(`EV ChargeOps listening on http://localhost:${port}`));
