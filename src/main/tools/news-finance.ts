type NewsProvider = "gdelt" | "newsapi";

export class NewsFinanceControl {
  async searchNews(query: string, limit: number, provider: NewsProvider = "gdelt") {
    if (provider === "newsapi") return this.searchNewsApi(query, limit);
    return this.searchGdelt(query, limit);
  }

  async searchSecFilings(company: string, forms: string[], limit: number) {
    const cik = normalizeCik(company);
    const url = new URL(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const payload = (await fetchJson(url, {
      headers: { "user-agent": process.env.HER_SEC_USER_AGENT || "Her local desktop agent contact@example.com" },
    })) as {
      name?: string;
      tickers?: string[];
      filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[] } };
    };
    const recent = payload.filings?.recent;
    const allowedForms = new Set(forms.map((form) => form.toUpperCase()));
    const filings = (recent?.form ?? [])
      .map((form, index) => ({
        form,
        filingDate: recent?.filingDate?.[index],
        accessionNumber: recent?.accessionNumber?.[index],
        document: recent?.primaryDocument?.[index],
      }))
      .filter((filing) => !allowedForms.size || allowedForms.has(filing.form.toUpperCase()))
      .slice(0, limit);
    return {
      status: "ok",
      source: "sec_submissions",
      company: payload.name ?? company,
      tickers: payload.tickers ?? [],
      filings,
    };
  }

  async lookupMacroSeries(seriesId: string, startYear?: string, endYear?: string) {
    const url = new URL("https://api.bls.gov/publicAPI/v2/timeseries/data/");
    const body = {
      seriesid: [seriesId],
      ...(startYear ? { startyear: startYear } : {}),
      ...(endYear ? { endyear: endYear } : {}),
    };
    const payload = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: "ok", source: "bls_public_api", seriesId, payload };
  }

  async lookupMarketQuote(symbol: string) {
    const apiKey = process.env.HER_ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      return {
        status: "missing_config",
        source: "alpha_vantage",
        missing: ["HER_ALPHA_VANTAGE_API_KEY"],
        note: "Configure HER_ALPHA_VANTAGE_API_KEY to use market quote lookup.",
      };
    }

    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "GLOBAL_QUOTE");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", apiKey);
    const payload = await fetchJson(url);
    return { status: "ok", source: "alpha_vantage", symbol, payload };
  }

  private async searchGdelt(query: string, limit: number) {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    url.searchParams.set("query", query);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", String(Math.max(1, Math.min(25, limit))));
    const payload = (await fetchJson(url)) as { articles?: unknown[] };
    return {
      status: "ok",
      provider: "gdelt",
      query,
      articles: payload.articles ?? [],
    };
  }

  private async searchNewsApi(query: string, limit: number) {
    const apiKey = process.env.HER_NEWS_API_KEY;
    if (!apiKey) {
      return {
        status: "missing_config",
        provider: "newsapi",
        missing: ["HER_NEWS_API_KEY"],
        note: "Configure HER_NEWS_API_KEY to use NewsAPI.",
      };
    }

    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("pageSize", String(Math.max(1, Math.min(25, limit))));
    url.searchParams.set("apiKey", apiKey);
    const payload = await fetchJson(url);
    return { status: "ok", provider: "newsapi", query, payload };
  }
}

const fetchJson = async (url: URL, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Research API request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};

const normalizeCik = (value: string) => {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) throw new Error("SEC filing lookup currently requires a numeric CIK.");
  return digits.padStart(10, "0");
};
