const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { token: localStorage.getItem('chargeops_token'), user: null, authMode: 'login', vehicles: [], models: [], stations: [], demoStations: [], publicStations: [], mapRawStations: [], selectedStation: null, activityFilter: 'all', map: null, markers: null, mapCenter: { latitude: 19.2403, longitude: 73.1305 }, locationMarker: null, currentLocation: null, mapRequest: 0, placeRequest: 0, mapUnavailable: false };

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
    $('#authPanel').classList.remove('hidden'); $('#appPanel').classList.add('hidden');
    $$('.signed-in-only').forEach(el => el.classList.add('hidden'));
    $('#logout').classList.add('hidden'); $('#whoami').classList.add('hidden'); return;
  }
  try {
    const { user } = await api('/me'); state.user = user;
    $('#authPanel').classList.add('hidden'); $('#appPanel').classList.remove('hidden');
    $$('.signed-in-only').forEach(el => el.classList.remove('hidden'));
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
    await Promise.all([loadVehicles(), loadModels(), loadBookings(), loadDemoStations()]);
    initializeMap();
    setTimeout(() => state.map?.invalidateSize(), 100);
    searchStations().catch(error => showMapMessage(error.message, true));
    if (operational) await loadMaintenance();
    if (!$('#analyticsPanel').classList.contains('hidden')) loadRanking().catch(() => {});
    initReveal();
  } catch (error) {
    if (error.message.includes('token') || error.message.includes('Unauthorized')) {
      state.token = null; localStorage.removeItem('chargeops_token'); $('#authPanel').classList.remove('hidden'); $('#appPanel').classList.add('hidden'); $$('.signed-in-only').forEach(el => el.classList.add('hidden')); $('#logout').classList.add('hidden'); $('#whoami').classList.add('hidden');
    } else toast(error.message, true);
  }
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

async function loadDemoStations() {
  const { stations } = await api('/stations');
  state.demoStations = stations;
  state.stations = stations;
  $('#demoStationResults').innerHTML = stations.length ? stations.map(s => '<article class="demo-station"><span class="demo-station-pin"><svg><use href="#i-pin"/></svg></span><div><b>' + html(s.name) + '</b><small>' + html(s.address) + ' · ' + html(s.city) + '</small><span class="demo-station-meta">' + Number(s.available_ports || 0) + ' free sample ports · ' + (s.energy_rate_per_kwh ? '₹' + Number(s.energy_rate_per_kwh).toFixed(2) + '/kWh' : 'rate shown at billing') + '</span></div><button class="button button-quiet" data-action="ports" data-id="' + s.station_id + '">Book sample session</button></article>').join('') : '<div class="empty-state">No sample stations are available.</div>';
}

function showMapMessage(message, isError = false) {
  const overlay = $('#mapLoading');
  overlay.classList.add('visible');
  overlay.classList.toggle('map-error', isError);
  $('.map-spinner').classList.toggle('hidden', isError);
  $('#mapStatus').textContent = message;
}
function hideMapMessage() {
  $('#mapLoading').classList.remove('visible', 'map-error');
  $('.map-spinner').classList.remove('hidden');
}
function initializeMap() {
  if (state.map) return true;
  if (!window.L) {
    state.mapUnavailable = true;
    showMapMessage('Interactive map library did not load. Charger results may still appear below.', true);
    return false;
  }
  state.map = L.map('networkMap', { scrollWheelZoom: false }).setView([state.mapCenter.latitude, state.mapCenter.longitude], 12);
  const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(state.map);
  tiles.on('tileerror', () => showMapMessage('Map tiles are temporarily unavailable. Try again later; station data may still load.', true));
  state.markers = L.layerGroup().addTo(state.map);
  return true;
}

function connectorMatches(station, selected) {
  if (!selected) return true;
  const values = station.connectors.join(' ').toLowerCase();
  if (selected === 'CCS2') return values.includes('ccs');
  if (selected === 'Type 2') return values.includes('type 2');
  if (selected === 'CHAdeMO') return values.includes('chademo');
  return values.includes(selected.toLowerCase());
}
function stationDistanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude), dLng = radians(b.longitude - a.longitude);
  const part = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(part), Math.sqrt(1 - part));
}
function stationReviewsUrl(station) {
  const query = [station.name, station.operator, station.address, station.city, station.state, station.latitude + ',' + station.longitude].filter(Boolean).join(' ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}
function stationPricingUrl(station) {
  const query = [station.operator, station.name, station.address, station.city, station.state, 'EV charging tariff price per kWh'].filter(Boolean).join(' ');
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}
function publicMarkerBounds() {
  return L.latLngBounds(state.markers.getLayers().map(marker => marker.getLatLng()));
}
function stationPopup(station) {
  const destination = station.latitude + ',' + station.longitude;
  return '<div class="charger-popup"><b>' + html(station.name) + '</b>' +
    (station.operator ? '<span>' + html(station.operator) + '</span>' : '') +
    '<small>' + html(station.address || 'Address not listed by source') + '</small>' +
    '<small>' + html(station.connectors.join(' · ') || 'Connector details not mapped') + '</small>' +
    '<em>' + html(station.availability_note || 'Current tariff and live availability are not provided by map data. Confirm both with the operator.') + '</em>' +
    '<em>The current station price is not included in this map record.</em>' +
    '<a href="' + html(stationPricingUrl(station)) + '" target="_blank" rel="noopener">Search operator tariff ↗</a>' +
    '<a href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(destination) + '" target="_blank" rel="noopener">Get directions ↗</a>' +
    '<a href="' + html(stationReviewsUrl(station)) + '" target="_blank" rel="noopener">Find reviews on Google Maps ↗</a>' +
    '<a href="' + html(station.source_url || station.osm_url || '#') + '" target="_blank" rel="noopener">' + html(station.source_label || 'View source record') + ' ↗</a></div>';
}
function drawPublicMap(stations, center, fit = false) {
  initializeMap();
  if (!state.map || !state.markers) return;
  state.mapCenter = center;
  state.markers.clearLayers();
  stations.forEach(station => {
    const marker = L.circleMarker([station.latitude, station.longitude], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#35795b', fillOpacity: .96
    }).bindPopup(stationPopup(station), { maxWidth: 260 });
    marker.addTo(state.markers);
    marker.on('click', () => { const card = document.querySelector('[data-public-id="' + CSS.escape(station.map_id || station.osm_id) + '"]'); card?.classList.add('station-card-selected'); setTimeout(() => card?.classList.remove('station-card-selected'), 1000); });
  });
  if (state.locationMarker) state.locationMarker.remove();
  if (state.currentLocation) {
    state.locationMarker = L.circleMarker([state.currentLocation.latitude, state.currentLocation.longitude], { radius: 7, color:'#fff', weight:2, fillColor:'#3678cb', fillOpacity:1 })
      .bindPopup('Your current location').addTo(state.map);
  }
  if (fit && stations.length > 1) state.map.fitBounds(publicMarkerBounds().pad(.16), { maxZoom: 15 });
  else if (stations.length === 1) state.map.setView([stations[0].latitude, stations[0].longitude], 15);
  else if (fit || !state.map.hasLayer(state.markers)) state.map.setView([center.latitude, center.longitude], 14);
  else if (state.markers.getLayers().length === 0) state.map.setView([center.latitude, center.longitude], 14);
  $('#mapZoomToResults').disabled = stations.length === 0;
  setTimeout(() => state.map.invalidateSize(), 80);
}
function renderPublicStations(stations, center, fit = false) {
  const connector = $('[name="connector"]').value;
  const filtered = stations.filter(station => connectorMatches(station, connector))
    .sort((a, b) => stationDistanceKm(center, a) - stationDistanceKm(center, b));
  state.publicStations = filtered;
  $('#resultCount').textContent = `${filtered.length} MAPPED`;
  $('#stationResults').innerHTML = filtered.length ? filtered.map((station, index) => {
    const km = stationDistanceKm(center, station);
    const connectorDetails = station.connector_details || station.connectors;
    const connectorSummary = connectorDetails.slice(0, 2).join(' · ') + (connectorDetails.length > 2 ? ' · +' + (connectorDetails.length - 2) + ' more' : '');
    const facts = [connectorSummary || 'Connectors not mapped', station.power ? station.power + ' capacity' : 'Power not listed'];
    return '<article class="station-card public-station-card" data-public-id="' + html(station.map_id || station.osm_id) + '" style="--item:' + index + '">' +
      '<span class="station-index">' + String(index + 1).padStart(2, '0') + '</span><div class="station-card-copy"><h3>' + html(station.name) + '</h3>' +
      '<p>' + html(station.operator || 'Operator not listed') + ' · ' + km.toFixed(1) + ' km away</p>' +
      '<div class="station-tags"><span>' + html(facts[0]) + '</span><span>' + html(facts[1]) + '</span></div>' +
      '<div class="station-data-note">' + html(station.source_label || 'Map record') + ' · tariff not provided; confirm price and availability with operator</div></div><div class="station-card-end">' +
      '<button class="button button-quiet" data-public-map="' + html(station.map_id || station.osm_id) + '">Show on map</button>' +
      '<a class="button button-outline" href="' + html(stationPricingUrl(station)) + '" target="_blank" rel="noopener">Search tariff ↗</a>' +
      '<a class="button button-outline" href="' + html(stationReviewsUrl(station)) + '" target="_blank" rel="noopener">Reviews ↗</a>' +
      '<a class="button button-outline" href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(station.latitude + ',' + station.longitude) + '" target="_blank" rel="noopener">Directions ↗</a>' +
      '</div></article>';
  }).join('') : '<div class="empty-state">' + (stations.length ? 'No nearby stations list this connector in OpenStreetMap. Clear the connector filter or verify with a local operator.' : 'OpenStreetMap has no charger records in this area yet. That does not mean there are no real chargers here; coverage can be incomplete. Check the <a href="https://xprest.tatamotors.com/electric/chargingpoint" target="_blank" rel="noopener">Tata charging point directory ↗</a> or <a href="https://evyatra.beeindia.gov.in/" target="_blank" rel="noopener">BEE EV Yatra ↗</a>, and confirm details with the operator.') + '</div>';
  drawPublicMap(filtered, center, fit);
}
async function loadPublicChargers(center, radius, options = {}) {
  const requestId = ++state.mapRequest;
  showMapMessage('Searching OpenStreetMap for mapped charging stations…');
  try {
    const params = new URLSearchParams({ latitude: center.latitude, longitude: center.longitude, radius: String(radius) });
    const data = await api('/map/public-chargers?' + params);
    if (requestId !== state.mapRequest) return;
    state.mapCenter = center;
    state.mapRawStations = data.stations || [];
    renderPublicStations(data.stations || [], center, options.fit);
    const updated = data.overpass_unavailable ? ' · Live OSM query unavailable' : data.source_timestamp ? ' · OSM updated ' + new Date(data.source_timestamp).toLocaleString() : '';
    const snapshot = ' · BEE snapshot 26 Oct 2025 (' + Number(data.national_dataset_count || 0).toLocaleString() + ' sites nationwide)';
    $('#mapStatus').textContent = (data.overpass_unavailable ? 'Showing archived records only: ' : '') + data.stations.length + ' public record' + (data.stations.length === 1 ? '' : 's') + ' within ' + (radius / 1000).toFixed(0) + ' km' + updated + snapshot + '. Prices and availability are not live.';
    if (state.mapUnavailable) showMapMessage('Interactive map library did not load. Charger results are listed below.', true);
    else hideMapMessage();
  } catch (error) {
    if (requestId !== state.mapRequest) return;
    showMapMessage(error.message, true);
    throw error;
  }
}
async function searchStations() {
  const query = $('[name="city"]').value.trim();
  if (query.length < 2) throw new Error('Enter a place name with at least 2 characters.');
  const radius = Number($('[name="radius"]').value) || 5000;
  const placeRequest = ++state.placeRequest;
  showMapMessage('Finding ' + query + '…');
  const { place } = await api('/map/geocode?q=' + encodeURIComponent(query));
  if (placeRequest !== state.placeRequest) return;
  const center = { latitude: Number(place.latitude), longitude: Number(place.longitude) };
  $('#mapStatus').textContent = 'Showing mapped public charger points near ' + query + '.';
  if (state.map) state.map.setView([center.latitude, center.longitude], radius <= 3000 ? 15 : radius <= 5000 ? 14 : 13);
  return loadPublicChargers(center, radius, { fit: true });
}
function loadMapArea() {
  if (!state.map) return;
  state.placeRequest++;
  const center = state.map.getCenter();
  const bounds = state.map.getBounds();
  const northEast = bounds.getNorthEast();
  const radius = Math.min(10000, Math.max(1000, Math.round(stationDistanceKm({ latitude:center.lat, longitude:center.lng }, { latitude:northEast.lat, longitude:northEast.lng }) * 1000)));
  return loadPublicChargers({ latitude:center.lat, longitude:center.lng }, radius, { fit:false });
}
function searchMyLocation() {
  const button = $('#useMyLocation');
  if (!navigator.geolocation) { toast('This browser does not support location access.', true); return; }
  if (button.disabled) return;
  state.placeRequest++;
  button.disabled = true;
  button.textContent = 'Getting location…';
  showMapMessage('Allow location access in your browser prompt to find nearby chargers…');
  navigator.geolocation.getCurrentPosition(position => {
    const center = { latitude:position.coords.latitude, longitude:position.coords.longitude };
    state.currentLocation = center;
    state.map?.setView([center.latitude, center.longitude], 14);
    const accuracy = Math.round(position.coords.accuracy);
    showMapMessage('Location found (about ' + accuracy + ' m accuracy). Searching nearby stations…');
    loadPublicChargers(center, Number($('[name="radius"]').value) || 5000, { fit:true })
      .catch(error => toast(error.message, true))
      .finally(() => { button.disabled = false; button.textContent = '◎ Use my location'; });
  }, error => {
    const messages = { 1:'Location access was denied. Allow it in your browser settings, or search for a place by name.', 2:'Your location is unavailable. Try searching for a place by name.', 3:'Location request timed out. Try again or search for a place by name.' };
    showMapMessage(messages[error.code] || 'Could not read your location.', true);
    button.disabled = false;
    button.textContent = '◎ Use my location';
  }, { enableHighAccuracy:true, timeout:20000, maximumAge:60000 });
}

async function openBooking(stationId, from = '', to = '') {
  if (!state.vehicles.length) { toast('Add an EV to your garage first.', true); $('#vehicleForm').classList.remove('hidden'); $('#garage').scrollIntoView({behavior:'smooth'}); return; }
  const { station } = await api(`/stations/${stationId}`); state.selectedStation = station;
  $('#bookingStationSummary').innerHTML = `<span class="summary-pin"><svg><use href="#i-pin"/></svg></span><div><strong>${html(station.name)}</strong><small>${html(station.address)} · ${html(station.city)}</small></div>`;
  $('#bookingRate').textContent = station.energy_rate_per_kwh ? `Demo ₹${Number(station.energy_rate_per_kwh).toFixed(2)} / kWh${Number(station.session_fee)>0?` · ₹${Number(station.session_fee).toFixed(0)} sample session fee`:''}` : 'Demo rate shown on final invoice';
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
$('#searchForm').addEventListener('submit', async e => { e.preventDefault(); try { await searchStations(); } catch (error) { showMapMessage(error.message, true); } });
$('.quick-filters').addEventListener('click', e => { const button = e.target.closest('[data-filter-city]'); if (!button) return; $('[name="city"]').value = button.dataset.filterCity; $('#searchForm').requestSubmit(); });
$('#stationResults').addEventListener('click', e => {
  const button = e.target.closest('[data-public-map]');
  if (button) {
    const station = state.publicStations.find(item => (item.map_id || item.osm_id) === button.dataset.publicMap);
    const marker = state.markers?.getLayers().find(item => item.getLatLng().lat === station?.latitude && item.getLatLng().lng === station?.longitude);
    if (station && marker) { state.map.panTo(marker.getLatLng()); marker.openPopup(); }
  }
});
$('#demoStationResults').addEventListener('click', e => { const button = e.target.closest('[data-action="ports"]'); if (button) handleBookingAction(button).catch(error => toast(error.message,true)); });
$('#showDemoBooking').addEventListener('click', () => {
  const panel = $('#demoNetwork');
  panel.open = true;
  panel.scrollIntoView({ behavior:'smooth', block:'center' });
});
$('#searchMapArea').addEventListener('click', () => loadMapArea()?.catch(error => toast(error.message,true)));
$('#mapZoomToResults').addEventListener('click', () => {
  if (state.markers?.getLayers().length > 1) state.map.fitBounds(publicMarkerBounds().pad(.16), { maxZoom:15 });
  else if (state.markers?.getLayers().length === 1) state.map.setView(state.markers.getLayers()[0].getLatLng(), 15);
});
$('#useMyLocation').addEventListener('click', searchMyLocation);
$('[name="connector"]').addEventListener('change', () => renderPublicStations(state.mapRawStations, state.mapCenter, false));
$('[name="radius"]').addEventListener('change', () => searchStations().catch(error => showMapMessage(error.message, true)));
$('#vehicleForm').addEventListener('submit', e => addVehicle(e).catch(error => toast(error.message,true)));
$('#toggleVehicleForm').addEventListener('click', () => { $('#vehicleForm').classList.toggle('hidden'); if (!$('#vehicleForm').classList.contains('hidden')) $('[name="vin"]').focus(); });
$('#cancelVehicle').addEventListener('click', () => $('#vehicleForm').classList.add('hidden'));
$('#bookingResults').addEventListener('click', e => { const button = e.target.closest('[data-action]'); if (button) handleBookingAction(button).catch(error => toast(error.message,true)); });
$('.activity-tabs').addEventListener('click', e => { const button = e.target.closest('[data-activity-filter]'); if (!button) return; state.activityFilter = button.dataset.activityFilter; $$('.activity-tab').forEach(tab => tab.classList.toggle('active', tab === button)); loadBookings().catch(error => toast(error.message,true)); });
$('#bookingForm').addEventListener('submit', async e => { e.preventDefault(); const button = $('#reserveButton'); button.disabled = true; try { const values = Object.fromEntries(new FormData(e.currentTarget)); const result = await api('/bookings', { method:'POST', body:JSON.stringify({ vehicleId:Number(values.vehicleId),portId:Number(values.portId),startAt:inputIso(values.startAt),endAt:inputIso(values.endAt) }) }); $('#bookingDialog').close(); toast(`Reserved. Booking #${result.booking_id}`); await Promise.all([loadBookings(),loadDemoStations()]); } catch(error) { $('#bookingMessage').textContent = error.message; } finally { button.disabled = false; } });
['#bookingVehicle','#bookingFrom','#bookingTo'].forEach(selector => $(selector).addEventListener('change', () => refreshAvailablePorts().catch(error => { $('#portHint').textContent = error.message; })));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
[$('#bookingDialog'),$('#faultDialog')].forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }));
$('#reportIssue').addEventListener('click', () => openFaultDialog().catch(error => toast(error.message,true)));
$('#faultForm').addEventListener('submit', async e => { e.preventDefault(); try { const data = Object.fromEntries(new FormData(e.currentTarget)); await api(`/ports/${data.portId}/maintenance`, { method:'POST', body:JSON.stringify(data) }); $('#faultDialog').close(); e.currentTarget.reset(); toast('Issue sent to the maintenance queue.'); if (!$('#operations').classList.contains('hidden')) await loadMaintenance(); } catch(error) { $('#faultMessage').textContent = error.message; } });
$('#loadRanking').addEventListener('click', () => loadRanking().catch(error => toast(error.message,true)));
$('#refreshBookings').addEventListener('click', () => loadBookings().catch(error => toast(error.message,true)));
$('#refreshMaintenance').addEventListener('click', () => loadMaintenance().catch(error => toast(error.message,true)));
$('#maintenanceResults').addEventListener('click', async e => { const button = e.target.closest('[data-action="resolve"]'); if (!button) return; try { await api(`/maintenance/${button.dataset.id}/resolve`,{method:'PATCH',body:'{}'}); toast('Maintenance ticket resolved.'); await Promise.all([loadMaintenance(),loadDemoStations()]); } catch(error) { toast(error.message,true); } });
$('#logout').addEventListener('click', () => { state.token = null; state.user = null; localStorage.removeItem('chargeops_token'); showApp(); });
$('#mobileMenu').addEventListener('click', () => { $('#mainNav').classList.toggle('open'); $('#mobileMenu').setAttribute('aria-expanded',$('#mainNav').classList.contains('open')); });
if (location.hash === '#activity') $('#activity').classList.remove('hidden');
$$('.nav-link').forEach(link => link.addEventListener('click', () => {
  $('#mainNav').classList.remove('open');
  if (link.getAttribute('href') !== '#activity') $('#activity').classList.add('hidden');
}));
$$('a[href="#activity"]').forEach(link => link.addEventListener('click', () => $('#activity').classList.remove('hidden')));

setDateDefaults();
showApp();
