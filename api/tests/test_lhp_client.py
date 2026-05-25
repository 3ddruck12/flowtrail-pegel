"""Tests für LHP-Client (Hochwasserzentralen API)."""

import unittest

from clients.hochwasserzentralen import HochwasserZentralenClient


class TestHochwasserZentralenClient(unittest.TestCase):
    def test_parse_geojson_features(self) -> None:
        payload = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "name": "Wesel",
                        "water": "Lippe",
                        "lhpClass": 1,
                        "stateClassName": "Kleines Hochwasser",
                    },
                }
            ],
        }
        client = HochwasserZentralenClient(base_url="https://example.test")
        mapping = client._parse_stations(payload)
        self.assertIn("lippe wesel", mapping)
        self.assertEqual(mapping["lippe wesel"], "Kleines Hochwasser")

    def test_parse_legacy_data_array(self) -> None:
        payload = {
            "data": [
                {
                    "name": "Dedenborn",
                    "water": "Rur",
                    "stateClassName": "Kein Hochwasser",
                }
            ]
        }
        client = HochwasserZentralenClient(base_url="https://example.test")
        mapping = client._parse_stations(payload)
        self.assertEqual(mapping.get("rur dedenborn"), "Kein Hochwasser")


if __name__ == "__main__":
    unittest.main()
