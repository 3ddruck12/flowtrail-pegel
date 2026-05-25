"""Tests für LHP-Client (Hochwasserzentralen API)."""

import unittest

from clients.hochwasserzentralen import HochwasserZentralenClient


class TestHochwasserZentralenClient(unittest.TestCase):
    def test_parse_geojson_features(self) -> None:
        payload = {
            "type": "FeatureCollection",
            "features": [
                {
                    "id": "NW_123",
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [6.7, 51.5]},
                    "properties": {
                        "name": "Wesel",
                        "water": "Lippe",
                        "lhpClass": 1,
                        "stateClassName": "Kleines Hochwasser",
                        "stateId": "DE-NW",
                        "stationLink": "https://example.test/wesel",
                    },
                }
            ],
        }
        client = HochwasserZentralenClient(base_url="https://example.test")
        stations = client._parse_lhp_stations(payload)
        self.assertEqual(len(stations), 1)
        self.assertEqual(stations[0].state_id, "DE-NW")
        self.assertEqual(stations[0].lhp_id, "NW_123")

        mapping = client._parse_stations(payload)
        self.assertIn("lippe wesel", mapping)
        self.assertEqual(mapping["lippe wesel"], "Kleines Hochwasser")

    def test_parse_legacy_data_array(self) -> None:
        payload = {
            "data": [
                {
                    "id": "NW_456",
                    "name": "Dedenborn",
                    "water": "Rur",
                    "stateClassName": "Kein Hochwasser",
                    "stateId": "DE-NW",
                }
            ]
        }
        client = HochwasserZentralenClient(base_url="https://example.test")
        mapping = client._parse_stations(payload)
        self.assertEqual(mapping.get("rur dedenborn"), "Kein Hochwasser")

    def test_station_for(self) -> None:
        payload = {
            "features": [
                {
                    "id": "NW_1",
                    "type": "Feature",
                    "properties": {
                        "name": "Eitorf",
                        "water": "Sieg",
                        "stateClassName": "Kein Hochwasser",
                        "stateId": "DE-NW",
                    },
                }
            ]
        }
        client = HochwasserZentralenClient(base_url="https://example.test")
        index = client._build_station_index(client._parse_lhp_stations(payload))
        station = client.station_for("Sieg", "Eitorf", index)
        self.assertIsNotNone(station)
        assert station is not None
        self.assertEqual(station.state_id, "DE-NW")


if __name__ == "__main__":
    unittest.main()
