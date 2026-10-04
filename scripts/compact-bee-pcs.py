"""Normalize and gzip the extracted BEE snapshot for efficient server-side use."""
import gzip
import json
import os

SOURCE = "data/bee-public-chargers.json"
OUTPUT = "data/india-charging-stations.json.gz"
EXISTING_OUTPUT = OUTPUT
STATE_NAMES = {
    "andaman & nicobar": "Andaman & Nicobar Islands",
    "ut of d&nh and d&d": "Dadra and Nagar Haveli and Daman and Diu",
    "uttrakhand": "Uttarakhand",
}

if os.path.exists(SOURCE):
    with open(SOURCE, encoding="utf-8") as file:
        source = json.load(file)
else:
    with gzip.open(EXISTING_OUTPUT, "rt", encoding="utf-8") as file:
        source = json.load(file)

stations = []
for station in source["stations"]:
    lat, lon = station["latitude"], station["longitude"]
    # A few source rows have malformed coordinates. Keep points in India's
    # broad geographic envelope so a typo cannot place a station overseas.
    if not (6 <= lat <= 38 and 68 <= lon <= 98):
        continue
    old_state = station["state"].strip()
    station["state"] = STATE_NAMES.get(old_state.casefold(), old_state.title())
    stations.append(station)

source["station_count"] = len(stations)
source["states_and_union_territories"] = len({station["state"] for station in stations})
source["stations"] = stations
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
with open(OUTPUT, "wb") as file:
    with gzip.GzipFile(fileobj=file, mode="wb", compresslevel=9, mtime=0) as zipped:
        zipped.write(json.dumps(source, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
print(json.dumps({"stations": len(stations), "regions": source["states_and_union_territories"], "bytes_gzip": os.path.getsize(OUTPUT)}))
