"""Tests für OpenHygon NRW Provider (offline)."""

import io
import unittest
import zipfile
from unittest.mock import patch

from clients.levels.base import RuleKey
from clients.levels.openhygon_nrw import NrwOpenHygonProvider
from models.schemas import RiverRule


STATIONS_CSV = """station_latitude;station_longitude;station_name;station_no;catchment_no;catchment_name
50.7769820674819;7.44269205350868;Eitorf;2725910000100;272;Siegeinzugsgebiet Westlich
51.0706796709132;6.99453151090942;Opladen;2736790000200;2736;Wuppereinzugsgebiet
51.9110050339911;9.13001082124116;Schieder-Nessenberg;4567000000100;4;Weserzuflüsse
"""

LEVELS_CSV = """station_no;time;value(cm)
2725910000100;2026-05-25T12:00:00.000+01:00;72.50
2736790000200;2026-05-25T12:00:00.000+01:00;88.00
4567000000100;2026-05-25T12:00:00.000+01:00;95.00
"""


def _zip_bytes(csv_text: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pegel.csv", csv_text)
    return buffer.getvalue()


class TestNrwOpenHygonProvider(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = NrwOpenHygonProvider()

    @patch.object(NrwOpenHygonProvider, "_get_bytes")
    def test_fetch_batch_matches_station_names(self, mock_get_bytes) -> None:
        mock_get_bytes.side_effect = [STATIONS_CSV.encode("utf-8"), _zip_bytes(LEVELS_CSV)]

        rules = [
            RiverRule(
                river="Sieg",
                station="Eitorf",
                min=30,
                ideal_min=30,
                ideal_max=55,
                max=90,
                state="DE-NW",
            ),
            RiverRule(
                river="Wupper",
                station="Opladen",
                min=38,
                ideal_min=38,
                ideal_max=63,
                max=98,
                state="DE-NW",
            ),
            RiverRule(
                river="Emmer",
                station="Nessenberg",
                min=73,
                ideal_min=73,
                ideal_max=116.8,
                max=182.5,
                state="DE-NW",
            ),
        ]

        readings = self.provider.fetch_batch(rules, {})
        self.assertEqual(len(readings), 3)
        self.assertAlmostEqual(readings[RuleKey("Sieg", "Eitorf")].current_cm, 72.5)
        self.assertAlmostEqual(readings[RuleKey("Emmer", "Nessenberg")].current_cm, 95.0)

    def test_supports_nrw_only(self) -> None:
        rule = RiverRule(
            river="Ahr",
            station="Müsch",
            min=60,
            ideal_min=60,
            ideal_max=96,
            max=150,
        )
        self.assertFalse(self.provider.supports(rule, None, "DE-RP"))
        self.assertTrue(self.provider.supports(rule, None, "DE-NW"))


if __name__ == "__main__":
    unittest.main()
