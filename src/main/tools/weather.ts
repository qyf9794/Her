type GeocodeResult = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
};

export class WeatherLookup {
  async lookup(location: string, date?: string) {
    const place = await geocode(location);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set("timezone", place.timezone ?? "auto");
    url.searchParams.set("current", "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("forecast_days", "7");
    const payload = await fetchJson(url);
    return {
      status: "ok",
      source: "open_meteo",
      requestedLocation: location,
      date,
      location: {
        name: place.name,
        country: place.country,
        region: place.admin1,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      },
      forecast: payload,
    };
  }
}

const geocode = async (location: string) => {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const payload = (await fetchJson(url)) as { results?: GeocodeResult[] };
  const [result] = payload.results ?? [];
  if (!result) throw new Error(`No weather location found for ${location}.`);
  return result;
};

const fetchJson = async (url: URL) => {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Weather request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};
