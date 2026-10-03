const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { token: localStorage.getItem('chargeops_token'), user: null, authMode: 'login', vehicles: [], models: [], stations: [], selectedStation: null, activityFilter: 'all', showAllStations: false };

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3400);
}
function html(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function localDateTime(value) { return new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)); }
function inputIso(value) { return value ? new Date(value).toISOString() : ''; }
function setDateDefaults(from = null, to = null) {
  const start = from ? new Date(from) : new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const end = to ? new Date(to) : new Date(start.getTime() + 60 * 60 * 1000);
  for (const [selector, date] of [['[name="from"]', start], ['[name="to"]', end], ['#bookingFrom', start], ['#bookingTo', end]]) {
    const el = $(selector); if (el) el.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
}
function setAuthMode(mode) {
  state.authMode = mode;
  $$('.segment').forEach(button => button.classList.toggle('active', button.dataset.authMode === mode));
  $('#nameField').classList.toggle('hidden', mode !== 'register');
  $('#authSubmit').innerHTML = mode === 'register' ? 'Create account <svg><use href="#i-arrow"/></svg>' : 'Sign in <svg><use href="#i-arrow"/></svg>';
  $('#authMessage').textContent = '';
}

async function showApp() {
  if (!state.token) {
    $('#authPanel').classList.remove('hidden'); $('#appPanel').classList.add('hidden'); $('#logout').classList.add('hidden'); $('#whoami').classList.add('hidden'); return;
  }
  try {
    const { user } = await api('/me'); state.user = user;
    $('#authPanel').classList.add('hidden'); $('#appPanel').classList.remove('hidden');
    $('#logout').classList.remove('hidden'); $('#whoami').classList.remove('hidden');
    $('#userName').textContent = user.display_name; $('#userAvatar').textContent = user.display_name.trim().charAt(0).toUpperCase();
    $('#welcomeName').textContent = `${user.display_name.split(' ')[0]}.`;
    const roles = user.roles || [];
    const operational = roles.some(role => ['TECHNICIAN','STATION_OPERATOR','ADMIN'].includes(role));
    $$('.operational-link').forEach(el => el.classList.toggle('hidden', !operational));
    $('#reportIssue').classList.toggle('hidden', !operational);
    $('#operations').classList.toggle('hidden', !operational);
    $('#analyticsPanel').classList.toggle('hidden', !roles.some(role => ['STATION_OPERATOR','FINANCE','ADMIN'].includes(role)));
    const health = await api('/health'); $('#serverTime').textContent = `Updated ${localDateTime(health.database.server_time)}`;
    await Promise.all([loadVehicles(), loadModels(), loadConnectors(), loadBookings(), searchStations()]);
    if (operational) await loadMaintenance();
    if (!$('#analyticsPanel').classList.contains('hidden')) loadRanking().catch(() => {});
    initReveal();
  } catch (error) {
    if (error.message.includes('token') || error.message.includes('Unauthorized')) {
      state.token = null; localStorage.removeItem('chargeops_token'); $('#authPanel').classList.remove('hidden'); $('#appPanel').classList.add('hidden');
    } else toast(error.message, true);
  }
}

async function loadConnectors() {
  const { stations } = await api('/stations');
  const details = await Promise.all(stations.slice(0, 15).map(s => api(`/stations/${s.station_id}`)));
  const names = [...new Set(details.flatMap(x => x.station.ports.flatMap(p => p.connectors)))].sort();
  const select = $('[name="connector"]'), keep = select.value;
  select.innerHTML = '<option value="">Any connector</option>' + names.map(n => `<option value="${html(n)}">${html(n)}</option>`).join(''); select.value = keep;
}

async function loadVehicles() {
  const { vehicles } = await api('/vehicles'); state.vehicles = vehicles;
  $('#vehicleList').innerHTML = vehicles.length ? vehicles.map((v, index) => `
    <article class="vehicle-item" style="--item:${index}"><span class="vehicle-icon"><svg><use href="#i-car"/></svg></span><span class="vehicle-copy"><strong>${html(v.nickname || `${v.make} ${v.model}`)}</strong>
    <small>${html(v.make)} ${html(v.model)} · ${html(v.battery_kwh)} kWh battery</small><span class="vehicle-connectors">${html((v.connector_names || '').split(',').filter(Boolean).join(' · ') || 'Connector details unavailable')}</span></span><span class="vehicle-arrow">↗</span></article>`).join('') : '<div class="empty-state">Add an EV to your garage to reserve a compatible charger.</div>';
  $('#bookingVehicle').innerHTML = vehicles.length ? vehicles.map(v => `<option value="${v.vehicle_id}">${html(v.nickname || `${v.make} ${v.model}`)} · …${html(v.vin.slice(-6))}</option>`).join('') : '<option value="">Add an EV to continue</option>';
}
async function loadModels() {
  const { models } = await api('/vehicle-models'); state.models = models;
  $('[name="modelId"]').innerHTML = '<option value="">Choose EV model</option>' + models.map(m => `<option value="${m.model_id}">${html(m.make)} ${html(m.model)} (${m.model_year})</option>`).join('');
}

function updateMetrics(bookings) {
  const completed = bookings.filter(b => b.session_status === 'COMPLETED');
  const energy = completed.reduce((sum, b) => sum + Number(b.energy_kwh || 0), 0);
  const spend = bookings.filter(b => ['PAID','PARTIALLY_PAID'].includes(b.invoice_status)).reduce((sum,b) => sum + Number(b.total_amount || 0),0);
  const next = bookings.filter(b => b.status === 'CONFIRMED' && new Date(b.start_at) >= new Date()).sort((a,b) => new Date(a.start_at)-new Date(b.start_at))[0];
  $('#statEnergy').textContent = `${energy.toFixed(1)}`; $('#statSessions').textContent = String(completed.length); $('#statSpend').textContent = `₹${spend.toFixed(0)}`;
  $('#statNext').textContent = next ? localDateTime(next.start_at).split(',')[0] : 'No booking';
  $('#statNextDetail').textContent = next ? `${next.station_name} · ${localDateTime(next.start_at).split(',').slice(1).join(',')}` : 'Your next stop will show up here';
}
function bookingCard(b) {
  const status = b.session_status || b.status;
  let actions = '';
  if (b.status === 'CONFIRMED' && new Date(b.start_at) <= Date.now() && new Date(b.end_at) >= Date.now()) actions = `<button class="button button-dark" data-action="start" data-id="${b.booking_id}">Start session</button>`;
  else if (b.status === 'CONFIRMED' && new Date(b.start_at) > Date.now()) actions = `<button class="button button-quiet" data-action="cancel" data-id="${b.booking_id}">Cancel</button>`;
  if (b.session_id && b.session_status === 'ACTIVE') actions = `<button class="button button-quiet" data-action="meter" data-id="${b.session_id}">Add 5 kWh</button><button class="button button-dark" data-action="complete" data-id="${b.session_id}">Finish & bill</button>`;
  if (b.invoice_id && ['UNPAID','PARTIALLY_PAID'].includes(b.invoice_status)) actions += `<button class="button button-primary" data-action="pay" data-id="${b.invoice_id}">Pay invoice</button>`;
  const badge = status.replaceAll('_',' ').toLowerCase();
  return `<article class="booking-row"><span class="booking-timeline"><i></i></span><div class="booking-main"><div class="booking-titleline"><strong>${html(b.station_name)}</strong><span class="status-pill ${html(status.toLowerCase())}">${html(badge)}</span></div><small>${html(b.port_code)} · ${localDateTime(b.start_at)} – ${localDateTime(b.end_at)} · ${html(b.nickname || 'EV')}</small>${Number(b.energy_kwh)>0?`<span class="booking-meta">${Number(b.energy_kwh).toFixed(1)} kWh delivered</span>`:''}</div><div class="booking-trailing">${b.total_amount?`<span class="booking-price">₹${Number(b.total_amount).toFixed(2)}</span>`:''}<div class="booking-actions">${actions}</div></div></article>`;
}
async function loadBookings() {
  const { bookings } = await api('/bookings'); updateMetrics(bookings);
  const now = Date.now();
  const filtered = bookings.filter(b => state.activityFilter === 'all' || (state.activityFilter === 'upcoming' ? b.status === 'CONFIRMED' && new Date(b.start_at).getTime() >= now : b.status !== 'CONFIRMED' || new Date(b.start_at).getTime() < now));
  $('#activityCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'record' : 'records'}`;
  $('#bookingResults').innerHTML = filtered.length ? filtered.map(bookingCard).join('') : `<div class="empty-state">${state.activityFilter === 'upcoming' ? 'No upcoming reservations. Find a charger to plan your next stop.' : 'No charging records in this view yet.'}</div>`;
}

async function searchStations() {
  const values = new FormData($('#searchForm')), params = new URLSearchParams();
  if (values.get('city')) params.set('city', values.get('city'));
  if (values.get('connector')) params.set('connector', values.get('connector'));
  const from = inputIso(values.get('from')), to = inputIso(values.get('to'));
  if (from && to) { params.set('from', from); params.set('to', to); }
  const { stations } = await api(`/stations?${params}`); state.stations = stations;
  $('#resultCount').textContent = `${stations.length} ${stations.length === 1 ? 'STATION' : 'STATIONS'}`;
  const shown = state.showAllStations ? stations : stations.slice(0, 4);
  $('#stationResults').innerHTML = stations.length ? shown.map((s,index) => `<article class="station-card" style="--item:${index}"><span class="station-index">${String(index+1).padStart(2,'0')}</span><div class="station-card-copy"><h3>${html(s.name)}</h3><p>${html(s.address)} · ${html(s.city)}</p><div class="station-tags"><span class="availability-tag ${Number(s.available_ports)>0?'':'busy'}"><i></i>${Number(s.available_ports || 0)} available</span><span>${Number(s.operational_ports || 0)} operational ports</span></div></div><div class="station-card-end"><span class="station-rate">${s.energy_rate_per_kwh ? `₹${Number(s.energy_rate_per_kwh).toFixed(0)}<small> / kWh</small>` : 'Live rate'}</span><button class="button button-quiet" data-action="ports" data-id="${s.station_id}" data-from="${html(from)}" data-to="${html(to)}">Reserve <svg><use href="#i-arrow"/></svg></button></div></article>`).join('') : '<div class="empty-state">No stations match those filters. Try another city or connector.</div>';
  $('#showMoreStations').classList.toggle('hidden', stations.length <= 4);
  $('#showMoreStations').innerHTML = state.showAllStations ? 'Show fewer stations <span>↑</span>' : `Show all ${stations.length} stations <span>↓</span>`;
  drawMap(stations);
}
function drawMap(stations) {
  const root = $('#mapPins');
  if (!stations.length) { root.innerHTML = ''; return; }
  const latitudes = stations.map(s => Number(s.latitude)), longitudes = stations.map(s => Number(s.longitude));
  const minLat = Math.min(...latitudes), maxLat = Math.max(...latitudes), minLng = Math.min(...longitudes), maxLng = Math.max(...longitudes);
  root.innerHTML = stations.slice(0, 20).map((s,index) => {
    const x = 12 + (maxLng === minLng ? index % 4 * 20 : (Number(s.longitude)-minLng)/(maxLng-minLng)*76);
    const y = 18 + (maxLat === minLat ? Math.floor(index/4)*17 : (maxLat-Number(s.latitude))/(maxLat-minLat)*62);
    return `<button class="map-pin ${Number(s.available_ports)>0?'has-availability':''}" style="left:${x}%;top:${y}%" data-action="ports" data-id="${s.station_id}" aria-label="Reserve at ${html(s.name)}"><svg><use href="#i-pin"/></svg><span>${index+1}</span></button>`;
  }).join('');
}

async function openBooking(stationId, from = '', to = '') {
  if (!state.vehicles.length) { toast('Add an EV to your garage first.', true); $('#vehicleForm').classList.remove('hidden'); $('#garage').scrollIntoView({behavior:'smooth'}); return; }
  const { station } = await api(`/stations/${stationId}`); state.selectedStation = station;
  $('#bookingStationSummary').innerHTML = `<span class="summary-pin"><svg><use href="#i-pin"/></svg></span><div><strong>${html(station.name)}</strong><small>${html(station.address)} · ${html(station.city)}</small></div>`;
  $('#bookingRate').textContent = station.energy_rate_per_kwh ? `₹${Number(station.energy_rate_per_kwh).toFixed(2)} / kWh${Number(station.session_fee)>0?` · ₹${Number(station.session_fee).toFixed(0)} session fee`:''}` : 'Rate shown on final invoice';
  setDateDefaults(from || null, to || null); $('#bookingMessage').textContent = ''; $('#bookingPort').innerHTML = '<option value="">Checking available ports…</option>';
  $('#bookingDialog').showModal(); await refreshAvailablePorts();
}
async function refreshAvailablePorts() {
  const station = state.selectedStation; if (!station) return;
  const vehicle = state.vehicles.find(v => Number(v.vehicle_id) === Number($('#bookingVehicle').value)) || state.vehicles[0];
  const compatible = new Set((vehicle?.connector_names || '').split(',').filter(Boolean));
  const from = inputIso($('#bookingFrom').value), to = inputIso($('#bookingTo').value);
  if (!from || !to || new Date(to) <= new Date(from)) { $('#bookingPort').innerHTML = '<option value="">Choose a valid time range</option>'; $('#portHint').textContent = 'End time must be after start time.'; return; }
  const candidates = station.ports.filter(p => p.operational_status === 'OPERATIONAL' && (!compatible.size || p.connectors.some(c => compatible.has(c))));
  const availability = await Promise.all(candidates.map(async p => ({ port:p, ...(await api(`/ports/${p.port_id}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)) })));
  const free = availability.filter(x => x.available);
  $('#bookingPort').innerHTML = free.length ? '<option value="">Choose a port</option>' + free.map(({port}) => `<option value="${port.port_id}">${html(port.port_code)} · ${Number(port.max_power_kw)} kW · ${html(port.connectors.join(', '))}</option>`).join('') : '<option value="">No compatible ports available</option>';
  $('#portHint').textContent = free.length ? `${free.length} compatible ${free.length===1?'port':'ports'} free for this time.` : 'Try another time or connector to see more options.';
}

async function addVehicle(event) {
  event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
  await api('/vehicles', { method:'POST', body:JSON.stringify(values) }); form.reset(); form.classList.add('hidden');
  await loadVehicles(); toast('EV added to your garage.');
}
async function handleBookingAction(button) {
  const id = button.dataset.id;
  switch (button.dataset.action) {
    case 'ports': return openBooking(id, button.dataset.from, button.dataset.to);
    case 'cancel': await api(`/bookings/${id}`, { method:'DELETE' }); toast('Booking cancelled.'); return loadBookings();
    case 'start': { const result = await api('/sessions', { method:'POST', body:JSON.stringify({ bookingId:Number(id) }) }); toast(`Charging session #${result.session_id} started.`); return loadBookings(); }
    case 'meter': { const { bookings } = await api('/bookings'); const current = bookings.find(row => Number(row.session_id) === Number(id)); const value = Number(current?.meter_value || 0) + 5; await api(`/sessions/${id}/meter-readings`, { method:'POST', body:JSON.stringify({ cumulativeKwh:value }) }); toast(`Meter reading updated to ${value.toFixed(1)} kWh.`); return loadBookings(); }
    case 'complete': { const invoice = await api(`/sessions/${id}/complete`, { method:'POST', body:'{}' }); toast(`Session closed · ${invoice.energy_kwh} kWh · ₹${Number(invoice.total_amount).toFixed(2)}`); return loadBookings(); }
    case 'pay': { const result = await api(`/invoices/${id}/payments`, { method:'POST', body:JSON.stringify({ method:'UPI', outcome:'SUCCEEDED' }) }); toast(`Payment ${result.status.toLowerCase()}. Invoice ${result.invoice_status.toLowerCase()}.`); return loadBookings(); }
  }
}
async function loadRanking() {
  const { rows } = await api('/analytics/station-ranking');
  $('#rankingResults').innerHTML = rows.slice(-8).reverse().map((row,index) => `<div class="rank-row"><span><i>${String(index+1).padStart(2,'0')}</i>${html(row.name)}<small>${html(row.month_start)}</small></span><b>${Number(row.energy_kwh).toFixed(1)} <small>kWh</small></b></div>`).join('') || '<div class="empty-state">Complete a session to build energy analytics.</div>';
}
async function loadMaintenance() {
  const { tickets } = await api('/maintenance');
  $('#maintenanceResults').innerHTML = tickets.map(t => `<article class="booking-row"><span class="booking-timeline"><i></i></span><div class="booking-main"><div class="booking-titleline"><strong>${html(t.station_name)} · ${html(t.port_code)}</strong><span class="status-pill ${t.status === 'RESOLVED'?'completed':'active'}">${html(t.status)}</span></div><small>${html(t.fault_category)} · ${html(t.description)} · ${html(t.priority)} · ${localDateTime(t.reported_at)}</small></div><div class="booking-actions">${t.status !== 'RESOLVED' && t.status !== 'CLOSED' ? `<button class="button button-dark" data-action="resolve" data-id="${t.ticket_id}">Resolve</button>` : ''}</div></article>`).join('') || '<div class="empty-state">No maintenance tickets. The network is looking good.</div>';
}
async function openFaultDialog() {
  const stations = state.stations.length ? state.stations : (await api('/stations')).stations;
  const details = await Promise.all(stations.map(s => api(`/stations/${s.station_id}`)));
  const ports = details.flatMap(d => d.station.ports.map(p => ({...p, station:d.station})));
  $('#faultPort').innerHTML = ports.map(p => `<option value="${p.port_id}">${html(p.station.name)} · ${html(p.port_code)}</option>`).join('');
  $('#faultMessage').textContent = ''; $('#faultDialog').showModal();
}

async function handleAuth(event) {
  event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
  const body = state.authMode === 'register' ? { email:values.email,password:values.password,displayName:values.displayName } : { email:values.email,password:values.password };
  const button = $('#authSubmit'); button.disabled = true;
  try {
    const result = await api(state.authMode === 'register' ? '/auth/register' : '/auth/login', { method:'POST', body:JSON.stringify(body) });
    state.token = result.token; localStorage.setItem('chargeops_token', result.token); form.reset(); await showApp(); toast(`Welcome, ${result.user.display_name.split(' ')[0]}.`);
  } catch (error) { $('#authMessage').textContent = error.message; } finally { button.disabled = false; }
}

function initReveal() {
  const items = $$('.reveal:not(.is-visible)');
  if (!('IntersectionObserver' in window)) { items.forEach(el => el.classList.add('is-visible')); return; }
  const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold:.08 });
  items.forEach(el => observer.observe(el));
}

$('.segmented').addEventListener('click', e => { const button = e.target.closest('[data-auth-mode]'); if (button) setAuthMode(button.dataset.authMode); });
$('#authForm').addEventListener('submit', handleAuth);
$('#searchForm').addEventListener('submit', async e => { e.preventDefault(); state.showAllStations = false; try { await searchStations(); } catch (error) { toast(error.message,true); } });
$('.quick-filters').addEventListener('click', e => { const button = e.target.closest('[data-filter-connector],[data-filter-city]'); if (!button) return; if (button.dataset.filterConnector) $('[name="connector"]').value = button.dataset.filterConnector; if (button.dataset.filterCity) $('[name="city"]').value = button.dataset.filterCity; $('#searchForm').requestSubmit(); });
$('#stationResults').addEventListener('click', e => { const button = e.target.closest('[data-action="ports"]'); if (button) handleBookingAction(button).catch(error => toast(error.message,true)); });
$('#mapPins').addEventListener('click', e => { const button = e.target.closest('[data-action="ports"]'); if (button) handleBookingAction(button).catch(error => toast(error.message,true)); });
$('#showMoreStations').addEventListener('click', () => { state.showAllStations = !state.showAllStations; searchStations().catch(error => toast(error.message,true)); });
$('#vehicleForm').addEventListener('submit', e => addVehicle(e).catch(error => toast(error.message,true)));
$('#toggleVehicleForm').addEventListener('click', () => { $('#vehicleForm').classList.toggle('hidden'); if (!$('#vehicleForm').classList.contains('hidden')) $('[name="vin"]').focus(); });
$('#cancelVehicle').addEventListener('click', () => $('#vehicleForm').classList.add('hidden'));
$('#bookingResults').addEventListener('click', e => { const button = e.target.closest('[data-action]'); if (button) handleBookingAction(button).catch(error => toast(error.message,true)); });
$('.activity-tabs').addEventListener('click', e => { const button = e.target.closest('[data-activity-filter]'); if (!button) return; state.activityFilter = button.dataset.activityFilter; $$('.activity-tab').forEach(tab => tab.classList.toggle('active', tab === button)); loadBookings().catch(error => toast(error.message,true)); });
$('#bookingForm').addEventListener('submit', async e => { e.preventDefault(); const button = $('#reserveButton'); button.disabled = true; try { const values = Object.fromEntries(new FormData(e.currentTarget)); const result = await api('/bookings', { method:'POST', body:JSON.stringify({ vehicleId:Number(values.vehicleId),portId:Number(values.portId),startAt:inputIso(values.startAt),endAt:inputIso(values.endAt) }) }); $('#bookingDialog').close(); toast(`Reserved. Booking #${result.booking_id}`); await Promise.all([loadBookings(),searchStations()]); } catch(error) { $('#bookingMessage').textContent = error.message; } finally { button.disabled = false; } });
['#bookingVehicle','#bookingFrom','#bookingTo'].forEach(selector => $(selector).addEventListener('change', () => refreshAvailablePorts().catch(error => { $('#portHint').textContent = error.message; })));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
[$('#bookingDialog'),$('#faultDialog')].forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }));
$('#reportIssue').addEventListener('click', () => openFaultDialog().catch(error => toast(error.message,true)));
$('#faultForm').addEventListener('submit', async e => { e.preventDefault(); try { const data = Object.fromEntries(new FormData(e.currentTarget)); await api(`/ports/${data.portId}/maintenance`, { method:'POST', body:JSON.stringify(data) }); $('#faultDialog').close(); e.currentTarget.reset(); toast('Issue sent to the maintenance queue.'); if (!$('#operations').classList.contains('hidden')) await loadMaintenance(); } catch(error) { $('#faultMessage').textContent = error.message; } });
$('#loadRanking').addEventListener('click', () => loadRanking().catch(error => toast(error.message,true)));
$('#refreshBookings').addEventListener('click', () => loadBookings().catch(error => toast(error.message,true)));
$('#refreshMaintenance').addEventListener('click', () => loadMaintenance().catch(error => toast(error.message,true)));
$('#maintenanceResults').addEventListener('click', async e => { const button = e.target.closest('[data-action="resolve"]'); if (!button) return; try { await api(`/maintenance/${button.dataset.id}/resolve`,{method:'PATCH',body:'{}'}); toast('Maintenance ticket resolved.'); await Promise.all([loadMaintenance(),searchStations()]); } catch(error) { toast(error.message,true); } });
$('#logout').addEventListener('click', () => { state.token = null; state.user = null; localStorage.removeItem('chargeops_token'); showApp(); });
$('#mobileMenu').addEventListener('click', () => { $('#mainNav').classList.toggle('open'); $('#mobileMenu').setAttribute('aria-expanded',$('#mainNav').classList.contains('open')); });
$$('.nav-link').forEach(link => link.addEventListener('click', () => $('#mainNav').classList.remove('open')));

setDateDefaults();
showApp();
