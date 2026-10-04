"""Extract BEE's public EV charging point PDF into the map's compact JSON feed."""
import hashlib
import json
import sys

import pdfplumber

SOURCE = "https://www.beeindia.gov.in/WriteReadData/RTF1984/EV_PCS_Data_29277.pdf"
PUBLISHED = "2025-10-26"
INPUT = sys.argv[1] if len(sys.argv) > 1 else "data/bee-public-chargers.pdf"
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else "data/bee-public-chargers.json"

def clean(value):
    return " ".join((value or "").split()).strip()

def number(value):
    try:
        return float(clean(value))
    except (TypeError, ValueError):
        return None

groups = {}
rows_seen = 0
with pdfplumber.open(INPUT) as document:
    for page_number, page in enumerate(document.pages, start=1):
        tables = page.extract_tables() or []
        for table in tables:
            for row in table[1:]:
                if len(row) < 12:
                    continue
                rows_seen += 1
                cpo, category, state, district, city, address = (clean(item) for item in row[:6])
                lat, lon = number(row[6]), number(row[7])
                connector, charger_kw, connector_kw, count = (clean(item) for item in row[8:12])
                if not cpo or not state or not address or lat is None or lon is None:
                    continue
                if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not connector:
                    continue
                key_text = "|".join((cpo.casefold(), state.casefold(), district.casefold(), city.casefold(), address.casefold(), f"{lat:.6f}", f"{lon:.6f}"))
                key = hashlib.sha1(key_text.encode("utf-8")).hexdigest()[:18]
                record = groups.setdefault(key, {
                    "map_id": "bee/" + key,
                    "name": address,
                    "operator": cpo,
                    "latitude": lat,
                    "longitude": lon,
                    "address": address,
                    "city": city,
                    "district": district,
                    "state": state,
                    "station_category": category,
                    "connectors": [],
                    "connector_details": [],
                    "source": "Bureau of Energy Efficiency (BEE)",
                    "source_label": "BEE public-station dataset · 26 Oct 2025",
                    "source_url": SOURCE,
                    "source_date": PUBLISHED,
                    "availability_note": "Archived government snapshot; current operation and availability are not confirmed.",
                })
                detail = connector
                if charger_kw:
                    detail += f" · {charger_kw} kW charger"
                if count:
                    detail += f" · {count} connector(s)"
                if detail not in record["connector_details"]:
                    record["connector_details"].append(detail)
                if connector not in record["connectors"]:
                    record["connectors"].append(connector)
        page.close()
        if page_number % 100 == 0:
            print(f"processed {page_number}/{len(document.pages)} pages", file=sys.stderr, flush=True)

stations = sorted(groups.values(), key=lambda item: (item["state"], item["city"], item["name"], item["map_id"]))
payload = {"source": "Bureau of Energy Efficiency (BEE)", "source_url": SOURCE, "source_date": PUBLISHED, "rows_in_source": rows_seen, "station_count": len(stations), "stations": stations}
with open(OUTPUT, "w", encoding="utf-8") as output:
    json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
print(json.dumps({"pages": len(document.pages), "source_rows": rows_seen, "valid_stations": len(stations), "bytes": __import__("os").path.getsize(OUTPUT), "states": len({item['state'] for item in stations}), "sample": stations[:2]}, ensure_ascii=False))
