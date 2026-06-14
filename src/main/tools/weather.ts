type GeocodeResult = {
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};

type ForecastDay = {
  date: string;
  temperatureMaxC?: number;
  temperatureMinC?: number;
  precipitationProbabilityMax?: number;
  weatherCode?: number;
  summary?: string;
};

export class WeatherLookup {
  async lookup(location: string, date?: string) {
    const place = await geocode(location);
    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.searchParams.set("latitude", String(place.latitude));
    forecastUrl.searchParams.set("longitude", String(place.longitude));
    forecastUrl.searchParams.set("timezone", place.timezone || "auto");
    forecastUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    forecastUrl.searchParams.set("forecast_days", "7");

    const response = await fetch(forecastUrl, { signal: AbortSignal.timeout(8000) });
    const payload = (await response.json().catch(() => ({}))) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
      };
    };
    if (!response.ok || !payload.daily?.time?.length) {
      throw new Error(`Weather forecast unavailable for ${location}.`);
    }

    const days = payload.daily.time.map((day, index): ForecastDay => {
      const weatherCode = payload.daily?.weather_code?.[index];
      return {
        date: day,
        temperatureMaxC: payload.daily?.temperature_2m_max?.[index],
        temperatureMinC: payload.daily?.temperature_2m_min?.[index],
        precipitationProbabilityMax: payload.daily?.precipitation_probability_max?.[index],
        weatherCode,
        summary: describeWeatherCode(weatherCode),
      };
    });
    const targetDate = normalizeDate(date);
    const selected = targetDate ? (days.find((day) => day.date === targetDate) ?? days[0]) : days[0];

    return {
      location: {
        query: location,
        name: place.name,
        admin1: place.admin1,
        country: place.country,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      },
      date: selected.date,
      forecast: selected,
      days,
      source: "open-meteo",
    };
  }
}

const geocode = async (location: string): Promise<Required<Pick<GeocodeResult, "latitude" | "longitude">> & GeocodeResult> => {
  for (const candidate of locationCandidates(location)) {
    const result = await geocodeOne(candidate);
    if (result) return result;
  }
  throw new Error(`Could not resolve weather location: ${location}`);
};

const geocodeOne = async (location: string): Promise<(Required<Pick<GeocodeResult, "latitude" | "longitude">> & GeocodeResult) | undefined> => {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const payload = (await response.json().catch(() => ({}))) as { results?: GeocodeResult[] };
  const result = response.ok ? payload.results?.[0] : undefined;
  if (typeof result?.latitude !== "number" || typeof result.longitude !== "number") return undefined;
  return {
    ...result,
    latitude: result.latitude,
    longitude: result.longitude,
  };
};

const locationAliasCandidates: Record<string, string[]> = {
  "河内": ["Hanoi"],
  "河内市": ["Hanoi"],
  "越南河内": ["Hanoi"],
  "越南河内市": ["Hanoi"],
  "河內": ["Hanoi"],
  "河內市": ["Hanoi"],
  "越南河內": ["Hanoi"],
  "越南河內市": ["Hanoi"],
};

const locationCandidates = (location: string) => {
  const aliases = locationAliasCandidates[normalizeLocationKey(location)] ?? [];
  const unique = new Set([...aliases, location.trim()].filter(Boolean));
  return [...unique];
};

const normalizeLocationKey = (location: string) =>
  location
    .trim()
    .toLowerCase()
    .replace(/[\s,，.。;；:：-]+/g, "");

const normalizeDate = (date: string | undefined) => {
  if (!date) return undefined;
  const explicitDate = date.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (explicitDate) return explicitDate;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
};

const describeWeatherCode = (code: number | undefined) => {
  if (typeof code !== "number") return undefined;
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "雪";
  if ([95, 96, 99].includes(code)) return "雷暴";
  return `天气代码 ${code}`;
};
