"""Manueller Sync-Job."""

from services.river_service import RiverService


def main() -> None:
    service = RiverService()
    result = service.sync_all()
    print("Sync abgeschlossen:", result)


if __name__ == "__main__":
    main()
