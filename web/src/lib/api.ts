const API_URL = process.env.API_URL || "http://localhost:3000";

export type CarSummary = {
  id: string;
  year: number;
  make: string;
  model: string;
  bodyType: string | null;
  generation: string | null;
  imageUrl: string | null;
  currentValue: number | null;
  salesCount: number;
  listingsCount: number;
  signal: string | null;
  confidence: number | null;
};

export type CarsResponse = {
  page: number;
  limit: number;
  total: number;
  cars: CarSummary[];
};

export async function fetchCars(params: Record<string, string | undefined>): Promise<CarsResponse> {
  const qs = new URLSearchParams();
  qs.set("tier", "collector"); // no gating in this build phase — see api/serialize.js
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const res = await fetch(`${API_URL}/api/cars?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type Sale = {
  date: string;
  mileage: number | null;
  price: number | null;
  currency: string | null;
  source: string | null;
  url: string | null;
  vin: string | null;
  /** sold = completed competitive sale · sold_after = sold post-auction by negotiation ·
   *  reserve_not_met = high bid only, NOT a sale (excluded from all valuation maths). */
  status: "sold" | "sold_after" | "reserve_not_met";
};

export type Listing = {
  firstSeen: string;
  mileage: number | null;
  price: number | null;
  currency: string | null;
  source: string | null;
  url: string | null;
};

export type CarDetail = {
  id: string;
  year: number;
  make: string;
  model: string;
  bodyType: string | null;
  generation: string | null;
  imageUrl: string | null;
  hp: number | null;
  zeroSixty: number | null;
  production: number | null;
  msrp: number | null;
  currentValue: number | null;
  medianPrice: number | null;
  retainedValue: number | null;
  signal: string | null;
  confidence: number | null;
  annualReturn: number | null;
  projections: {
    forecast1y: number | null; forecast3y: number | null; forecast5y: number | null;
    bear3y: number | null; bull3y: number | null; bear5y: number | null; bull5y: number | null;
  } | null;
  bestMonths: number[] | null;
  worstMonths: number[] | null;
  seasonalStrength: number | null;
  collectibility: { score: number | null; reasons: string[] } | null;
  buyHoldSell: { label: string | null; copy: string | null } | null;
  segment: string | null;
  liquidity: { verdict: string | null; copy: string | null; monthsOfSupply: number | null };
  salesCount: number;
  sales: Sale[];
  listingsCount: number;
  listings: Listing[];
  relatedYears: { id: string; year: number }[];
};

export async function fetchCarDetail(id: string): Promise<CarDetail | null> {
  const res = await fetch(`${API_URL}/api/cars/${id}?tier=collector`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type TrendingCar = {
  id: string; year: number; make: string; model: string; body_type: string | null;
  current_value: number | null; annual_return: number | null; trend_score: number | null;
  sales_count: number; confidence: number | null; signal: string | null;
  listings_count?: number; image_url: string | null;
};

export type TrendingResponse = {
  health: Record<string, number>;
  gainers: TrendingCar[];
  decliners: TrendingCar[];
  segments: { segment: string; count: number; avgReturn: number; avgValue: number }[];
  bottomed: TrendingCar[];
};

export async function fetchTrending(): Promise<TrendingResponse> {
  const res = await fetch(`${API_URL}/api/trending`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type Deal = {
  listing_id: string; price: number; mileage: number | null; source: string; url: string | null;
  first_seen_at: string | null; car_id: string; year: number; make: string; model: string;
  current_value: number; annual_return: number | null; signal: string | null;
  confidence: number | null; sales_count: number; image_url: string | null; discount: number;
};

export async function fetchDeals(): Promise<{ total: number; rejectedAsUnverifiable: number; deals: Deal[] }> {
  const res = await fetch(`${API_URL}/api/deals`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type CompareCar = {
  id: string; year: number; make: string; model: string; body_type: string | null;
  generation: string | null; current_value: number | null; median_price: number | null;
  signal: string | null; confidence: number | null; annual_return: number | null;
  forecast_1y: number | null; forecast_3y: number | null; forecast_5y: number | null;
  collectibility_score: number | null; collectibility_reasons: string[];
  liquidity_verdict: string | null; months_of_supply: number | null;
  sales_count: number; avg_mileage: number | null;
  buy_hold_sell: string | null; buy_hold_sell_copy: string | null;
  best_months: number[]; worst_months: number[]; segment: string | null;
  listings_count: number; image_url: string | null;
  sales: { sold_at: string; price: number; mileage: number | null }[];
};

export async function fetchCompare(ids: string[]): Promise<{ cars: CompareCar[] }> {
  if (!ids.length) return { cars: [] };
  const res = await fetch(`${API_URL}/api/compare?ids=${ids.join(",")}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export async function searchCars(q: string): Promise<{ results: { id: string; year: number; make: string; model: string; current_value: number | null; sales_count: number }[] }> {
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
  if (!res.ok) return { results: [] };
  return res.json();
}

export async function fetchReprice(id: string, miles: number): Promise<number | null> {
  const res = await fetch(`${API_URL}/api/cars/${id}/reprice?miles=${miles}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return data.value;
}

export const MAKES = [
  "AC","AM General","AMC","Acura","Alfa Romeo","Alpina","Aston Martin","Audi","Autokraft",
  "Autozam","BAC","BMW","Beck","Bentley","Bizzarrini","Bugatti","Buick","Cadillac","Chevrolet",
  "Chrysler","Citroen","Cizeta","Datsun","Dodge","ERA","Excalibur","Ferrari","Fiat","Ford",
  "GMC","Hennessey","Henry","Honda","Jaguar","Jeep","Jensen","Koenigsegg","Lamborghini",
  "Lancia","Land Rover","Lexus","Lincoln","Lotus","Lucid","Maserati","Maybach","Mazda",
  "Mazdaspeed","McLaren","Mercedes","Mercury",
  "Mitsubishi","Morgan","Nissan","Noble","Oldsmobile","Pagani","Panoz","Peugeot","Plymouth",
  "Polestar","Pontiac","Porsche","RUF","Radical","Ram","Renault","Rimac","Rivian",
  "Rolls-Royce","SRT","Saab","Saleen","Shelby","Subaru","TVR","Tesla","Toyota","Volvo",
];

export const BODY_TYPES = ["Coupe", "Convertible", "Sedan", "SUV", "Wagon", "Hatchback", "Pickup", "Van", "Targa"];

export const YEAR_BUCKETS: { value: string; label: string }[] = [
  { value: "pre70", label: "Pre-1970" },
  { value: "70s", label: "1970s" },
  { value: "80s", label: "1980s" },
  { value: "90s", label: "1990s" },
  { value: "00s", label: "2000s" },
  { value: "10s", label: "2010s" },
  { value: "20s", label: "2020+" },
];

export const PRICE_BANDS: { value: string; label: string }[] = [
  { value: "under50k", label: "Under $50k" },
  { value: "50to100k", label: "$50–100k" },
  { value: "100to250k", label: "$100–250k" },
  { value: "250kplus", label: "$250k+" },
];

export const SORTS: { value: string; label: string }[] = [
  { value: "popular", label: "Popular" },
  { value: "price-high", label: "Price ↓" },
  { value: "price-low", label: "Price ↑" },
  { value: "year-new", label: "Newest" },
  { value: "year-old", label: "Oldest" },
];
