"""Tests für rules.json Loader."""

import json
import tempfile
import unittest
from pathlib import Path

from loaders.rules_file import load_rules_from_file, parse_rule


class TestRulesFileLoader(unittest.TestCase):
    def test_parse_rule(self) -> None:
        rule = parse_rule(
            {
                "river": "Rur",
                "station": "Dedenborn",
                "min_cm": 35,
                "ideal_min_cm": 35,
                "ideal_max_cm": 60,
                "max_cm": 95,
                "nrw_befahrbarkeit": "nicht befahrbar",
            }
        )
        self.assertEqual(rule.river, "Rur")
        self.assertEqual(rule.min, 35.0)
        self.assertEqual(rule.source, "flowtrail_rules")

    def test_load_rules_from_file(self) -> None:
        payload = {
            "version": "2026-05-25",
            "rules": [
                {"river": "Lahn", "station": "Biedenkopf", "min_cm": 50},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rules.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            rules = load_rules_from_file(path)
            self.assertEqual(len(rules), 1)
            self.assertEqual(rules[0].ideal_min, 50.0)


if __name__ == "__main__":
    unittest.main()
