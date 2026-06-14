import { config } from "../config";

type DisplayItem = {
  title: string;
  subtitle?: string;
  url?: string;
  meta?: Record<string, string | number | boolean | undefined>;
  body?: string;
};

type ToolDisplay = {
  title: string;
  subtitle?: string;
  kind: "news" | "finance" | "filings" | "macro";
  generatedAt: string;
  source: string;
  items: DisplayItem[];
  metrics?: Array<{ label: string; value: string; detail?: string }>;
  note?: string;
};

type GdeltArticle = {
  title?: string;
  url?: string;
  sourceCountry?: string;
  sourceCollection?: string;
  domain?: string;
  seendate?: string;
  language?: string;
  socialimage?: string;
};

type SecCompanyTicker = {
  cik_str?: number;
  ticker?: string;
  title?: string;
};

type SecSubmissions = {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: Record<string, string[]>;
  };
};

type BlsResponse = {
  status?: string;
  message?: string[];
  Results?: {
    series?: Array<{
      seriesID?: string;
      data?: Array<{
        year?: string;
        period?: string;
        periodName?: string;
        latest?: string;
        value?: string;
        footnotes?: Array<{ code?: string; text?: string }>;
      }>;
    }>;
  };
};

type AlphaVantageQuote = {
  "01. symbol"?: string;
  "02. open"?: string;
  "03. high"?: string;
  "04. low"?: string;
  "05. price"?: string;
  "06. volume"?: string;
  "07. latest trading day"?: string;
  "08. previous close"?: string;
  "09. change"?: string;
  "10. change percent"?: string;
};

let tickerCache: { createdAt: number; value: SecCompanyTicker[] } | undefined;
const SEC_TICKER_TTL_MS = 24 * 60 * 60 * 1000;

export class NewsFinanceControl {
  async searchNews(query: string, limit = 8, provider: "gdelt" | "newsapi" = "gdelt") {
    if (provider === "newsapi") return this.searchNewsApi(query, limit);
    return this.searchGdelt(query, limit);
  }

  async searchSecFilings(company: string, forms: string[] = [], limit = 10) {
    const companyMatch = await resolveSecCompany(company);
    const url = `https://data.sec.gov/submissions/CIK${companyMatch.cik}.json`;
    const payload = await fetchJson<SecSubmissions>(url, {
      headers: { "user-agent": config.secUserAgent, accept: "application/json" },
    });
    const recent = payload.filings?.recent ?? {};
    const accessionNumbers = recent.accessionNumber ?? [];
    const rows = accessionNumbers.map((accession, index) => ({
      accession,
      form: recent.form?.[index] ?? "",
      filingDate: recent.filingDate?.[index] ?? "",
      reportDate: recent.reportDate?.[index] ?? "",
      primaryDocument: recent.primaryDocument?.[index] ?? "",
      description: recent.primaryDocDescription?.[index] ?? "",
    }));
    const wantedForms = forms.map((form) => form.toUpperCase()).filter(Boolean);
    const filtered = rows
      .filter((row) => wantedForms.length === 0 || wantedForms.includes(row.form.toUpperCase()))
      .slice(0, Math.max(1, Math.min(30, limit)));
    const items = filtered.map((row) => ({
      title: `${row.form} ${row.filingDate}`,
      subtitle: row.description || row.reportDate || row.accession,
      url: secFilingUrl(companyMatch.cik, row.accession, row.primaryDocument),
      meta: {
        accession: row.accession,
        reportDate: row.reportDate,
        form: row.form,
      },
    }));
    return withDisplay(
      {
        status: "ok",
        source: "sec_edgar",
        company: payload.name ?? companyMatch.title,
        ticker: companyMatch.ticker,
        cik: companyMatch.cik,
        filings: filtered,
      },
      {
        title: `SEC filings: ${payload.name ?? companyMatch.title}`,
        subtitle: [companyMatch.ticker, companyMatch.cik, wantedForms.join(", ")].filter(Boolean).join(" · "),
        kind: "filings",
        generatedAt: new Date().toISOString(),
        source: "SEC EDGAR",
        items,
        note: "Official SEC EDGAR submissions data. Filing links open SEC archive documents.",
      },
    );
  }

  async lookupMacroSeries(seriesId: string, startYear?: string, endYear?: string) {
    const now = new Date();
    const start = startYear ?? String(now.getFullYear() - 1);
    const end = endYear ?? String(now.getFullYear());
    const body: Record<string, unknown> = {
      seriesid: [seriesId],
      startyear: start,
      endyear: end,
    };
    if (config.blsApiKey) body.registrationkey = config.blsApiKey;
    const payload = await fetchJson<BlsResponse>("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const series = payload.Results?.series?.[0];
    const data = (series?.data ?? []).slice(0, 24);
    const latest = data.find((point) => point.latest === "true") ?? data[0];
    const items = data.map((point) => ({
      title: `${point.periodName ?? point.period} ${point.year}`,
      subtitle: point.value,
      meta: {
        period: point.period,
        latest: point.latest === "true",
        footnote: point.footnotes?.map((footnote) => footnote.text).filter(Boolean).join("; "),
      },
    }));
    return withDisplay(
      {
        status: payload.status === "REQUEST_SUCCEEDED" ? "ok" : "error",
        source: "bls",
        seriesId,
        message: payload.message ?? [],
        data,
      },
      {
        title: `BLS macro series: ${seriesId}`,
        subtitle: `${start} to ${end}`,
        kind: "macro",
        generatedAt: new Date().toISOString(),
        source: "BLS Public Data API",
        metrics: latest?.value ? [{ label: "Latest", value: latest.value, detail: `${latest.periodName ?? latest.period} ${latest.year}` }] : undefined,
        items,
        note: "Official BLS public data. Some periods may be unavailable during publication gaps or revisions.",
      },
    );
  }

  async lookupMarketQuote(symbol: string) {
    const apiKey = config.alphaVantageApiKey || (symbol.toUpperCase() === "IBM" ? "demo" : "");
    if (!apiKey) {
      return withDisplay(
        {
          status: "missing_config",
          source: "alpha_vantage",
          missing: ["HER_ALPHA_VANTAGE_API_KEY"],
          symbol: symbol.toUpperCase(),
        },
        {
          title: `Market quote: ${symbol.toUpperCase()}`,
          subtitle: "Missing Alpha Vantage API key",
          kind: "finance",
          generatedAt: new Date().toISOString(),
          source: "Alpha Vantage",
          items: [],
          note: "Set HER_ALPHA_VANTAGE_API_KEY for non-demo symbols. Market data can be delayed and subject to provider/venue licensing.",
        },
      );
    }
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "GLOBAL_QUOTE");
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("apikey", apiKey);
    const payload = await fetchJson<{ "Global Quote"?: AlphaVantageQuote; Note?: string; Information?: string }>(url.toString());
    const quote = payload["Global Quote"];
    const metrics = quote
      ? [
          { label: "Price", value: quote["05. price"] ?? "n/a", detail: quote["07. latest trading day"] },
          { label: "Change", value: quote["09. change"] ?? "n/a", detail: quote["10. change percent"] },
          { label: "Volume", value: quote["06. volume"] ?? "n/a" },
          { label: "Previous Close", value: quote["08. previous close"] ?? "n/a" },
        ]
      : [];
    return withDisplay(
      {
        status: quote ? "ok" : "unavailable",
        source: "alpha_vantage",
        symbol: symbol.toUpperCase(),
        quote,
        providerMessage: payload.Note ?? payload.Information,
      },
      {
        title: `Market quote: ${symbol.toUpperCase()}`,
        subtitle: quote?.["07. latest trading day"] ?? "Alpha Vantage",
        kind: "finance",
        generatedAt: new Date().toISOString(),
        source: "Alpha Vantage",
        metrics,
        items: quote
          ? [
              { title: "Open", subtitle: quote["02. open"] },
              { title: "High", subtitle: quote["03. high"] },
              { title: "Low", subtitle: quote["04. low"] },
            ]
          : [],
        note:
          payload.Note ??
          payload.Information ??
          (apiKey === "demo" ? "Using Alpha Vantage demo key for IBM connectivity only." : "Market data may be delayed and subject to licensing."),
      },
    );
  }

  private async searchGdelt(query: string, limit: number) {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    url.searchParams.set("query", query);
    url.searchParams.set("mode", "artlist");
    url.searchParams.set("format", "json");
    url.searchParams.set("sort", "hybridrel");
    url.searchParams.set("maxrecords", String(Math.max(1, Math.min(25, limit))));
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const text = await response.text();
    if (!response.ok || !text.trim().startsWith("{")) {
      const rateLimited = /limit requests|rate limit|too many requests/i.test(text);
      return withDisplay(
        {
          status: rateLimited ? "rate_limited" : "error",
          source: "gdelt",
          query,
          httpStatus: response.status,
          message: text.slice(0, 500),
        },
        {
          title: `News search: ${query}`,
          subtitle: "GDELT did not return article data",
          kind: "news",
          generatedAt: new Date().toISOString(),
          source: "GDELT 2.0 DOC API",
          items: [],
          note: text.slice(0, 300),
        },
      );
    }
    const payload = JSON.parse(text) as { articles?: GdeltArticle[] };
    const articles = payload.articles ?? [];
    const items = articles.map((article) => ({
      title: article.title ?? article.url ?? "Untitled article",
      subtitle: [article.domain, article.seendate, article.sourceCountry].filter(Boolean).join(" · "),
      url: article.url,
      meta: {
        language: article.language,
        sourceCollection: article.sourceCollection,
      },
    }));
    return withDisplay(
      {
        status: "ok",
        source: "gdelt",
        query,
        articles,
      },
      {
        title: `News search: ${query}`,
        subtitle: `${articles.length} articles`,
        kind: "news",
        generatedAt: new Date().toISOString(),
        source: "GDELT 2.0 DOC API",
        items,
        note: "GDELT returns news index metadata and links, not guaranteed full article text.",
      },
    );
  }

  private async searchNewsApi(query: string, limit: number) {
    if (!config.newsApiKey) {
      return withDisplay(
        {
          status: "missing_config",
          source: "newsapi",
          missing: ["HER_NEWS_API_KEY"],
          query,
        },
        {
          title: `News search: ${query}`,
          subtitle: "Missing NewsAPI key",
          kind: "news",
          generatedAt: new Date().toISOString(),
          source: "NewsAPI",
          items: [],
          note: "Set HER_NEWS_API_KEY to use NewsAPI. Respect provider terms for display, caching, and production use.",
        },
      );
    }
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("pageSize", String(Math.max(1, Math.min(20, limit))));
    url.searchParams.set("sortBy", "publishedAt");
    const payload = await fetchJson<{
      status?: string;
      articles?: Array<{ title?: string; description?: string; url?: string; source?: { name?: string }; publishedAt?: string }>;
      message?: string;
    }>(url.toString(), { headers: { "x-api-key": config.newsApiKey } });
    const articles = payload.articles ?? [];
    return withDisplay(
      {
        status: payload.status === "ok" ? "ok" : "error",
        source: "newsapi",
        query,
        articles,
        message: payload.message,
      },
      {
        title: `News search: ${query}`,
        subtitle: `${articles.length} articles`,
        kind: "news",
        generatedAt: new Date().toISOString(),
        source: "NewsAPI",
        items: articles.map((article) => ({
          title: article.title ?? "Untitled article",
          subtitle: [article.source?.name, article.publishedAt].filter(Boolean).join(" · "),
          body: article.description,
          url: article.url,
        })),
        note: "NewsAPI content display/cache is subject to the selected plan and provider terms.",
      },
    );
  }
}

const resolveSecCompany = async (input: string) => {
  const normalized = input.trim().toUpperCase();
  if (/^\d{1,10}$/.test(normalized)) {
    return { cik: normalized.padStart(10, "0"), ticker: undefined, title: `CIK ${normalized}` };
  }
  const companies = await fetchSecTickers();
  const exact = companies.find((company) => company.ticker?.toUpperCase() === normalized);
  const fuzzy = exact ?? companies.find((company) => company.title?.toUpperCase().includes(normalized));
  if (!fuzzy?.cik_str) throw new Error(`Could not resolve SEC ticker or company: ${input}`);
  return {
    cik: String(fuzzy.cik_str).padStart(10, "0"),
    ticker: fuzzy.ticker,
    title: fuzzy.title,
  };
};

const fetchSecTickers = async () => {
  if (tickerCache && Date.now() - tickerCache.createdAt < SEC_TICKER_TTL_MS) return tickerCache.value;
  const payload = await fetchJson<Record<string, SecCompanyTicker>>("https://www.sec.gov/files/company_tickers.json", {
    headers: { "user-agent": config.secUserAgent, accept: "application/json" },
  });
  const value = Object.values(payload);
  tickerCache = { createdAt: Date.now(), value };
  return value;
};

const secFilingUrl = (cik: string, accession: string, primaryDocument: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${primaryDocument}`;

const fetchJson = async <T>(url: string | URL, init: RequestInit = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  const payload = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};

const withDisplay = <T extends Record<string, unknown>>(result: T, display: ToolDisplay) => ({
  ...result,
  display,
});
