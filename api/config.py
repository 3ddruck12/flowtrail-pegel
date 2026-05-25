from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8080
    debug: bool = True

    pegel_cache_ttl: int = 600
    rules_cache_ttl: int = 3600

    pegelonline_base_url: str = "https://www.pegelonline.wsv.de/webservices/rest-api/v2"
    kanu_nrw_pegel_url: str = "https://sites.kanu-nrw.de/pegel.php"
    rules_file_path: str = "./data/rules.json"
    lhp_api_base_url: str = "https://api.hochwasserzentralen.de/public/v1"

    openhygon_stations_url: str = (
        "https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/"
        "oberflaechengewaesser/hygon/OpenHygon-Pegel-Stationen_EPSG4326.txt"
    )
    openhygon_current_csv_url: str = (
        "https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/"
        "oberflaechengewaesser/hygon/OpenHygon-Pegel-aktuell_CSV.zip"
    )
    openhygon_cache_ttl: int = 600

    database_path: str = "./data/befahrbarkeit.db"
    sync_interval_minutes: int = 120

    @property
    def db_path(self) -> Path:
        path = Path(self.database_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def rules_path(self) -> Path:
        return Path(self.rules_file_path)


settings = Settings()
