require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

app.use(express.static(__dirname));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MARKETCHECK_API_KEY = process.env.MARKETCHECK_API_KEY;
const cache = new Map();

async function cachedGet(key, url) {
  if (cache.has(key)) return cache.get(key);
  const res = await axios.get(url);
  cache.set(key, res.data);
  return res.data;
}

function money(n) {
  return Math.round(Number(n || 0));
}

function weightedMedian(values, weights) {
  const sorted = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);

  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;

  for (const item of sorted) {
    acc += item.w;
    if (acc >= total / 2) return item.v;
  }

  return sorted[0]?.v || 0;
}

function trimRank(trim) {
  const t = String(trim || '').toLowerCase();

  if (!t || t === 'any trim') return 2;

  if (['base', 's', 'lx', 'l', 'xl', 'wt'].some(x => t === x)) return 1;
  if (['se', 'sport', 'ex', 'xlt', 'lt', 'premium'].some(x => t.includes(x))) return 2;
  if (['sel', 'limited', 'touring', 'xle', 'lariat', 'ltz'].some(x => t.includes(x))) return 3;
  if (['platinum', 'denali', 'high country', 'king ranch', 'trd pro', 'type r', 'gli', 'amg', 'rs'].some(x => t.includes(x))) return 4;

  return 2;
}

function getValueScore(car, searchedTrim, searchedMileage) {
  const trimDelta = trimRank(car.displayTrim) - trimRank(searchedTrim);

  // Convert everything into an "adjusted cost"
  // Lower adjusted cost = better value.
  let adjustedCost = Number(car.price || 0);

  // Higher trim gets a dollar-value credit.
  adjustedCost -= trimDelta * 750;

  // Mileage adjustment:
  // Every 10k miles below the searched vehicle is worth about $350.
  // Every 10k miles above costs about $350.
  if (car.miles && searchedMileage) {
    const mileageDiff = Number(car.miles) - Number(searchedMileage);
    adjustedCost += (mileageDiff / 10000) * 200;
  }

  // Distance matters, but lightly.
  if (car.dist) {
    adjustedCost += car.dist * 5;
  }

  // Convert adjusted cost into a score.
  // Lower adjusted cost gets a higher score.
  const score = 100 - (adjustedCost / 400);

  return Math.round(score * 10) / 10;
}


function getValueLabel(car, searchedTrim) {
  const trimDelta = trimRank(car.displayTrim) - trimRank(searchedTrim);

  if (trimDelta > 0) return 'Higher trim — potentially better value';
  if (trimDelta < 0) return 'Lower trim — compare carefully';
  return 'Same/similar trim';
}

function getSegment(make, model) {
  const mk = String(make || '').toLowerCase();
  const m = String(model || '').toLowerCase();

  const truckModels = ['f-150', 'silverado', 'sierra', 'ram', 'tundra', 'tacoma', 'frontier', 'ranger', 'maverick', 'colorado'];
  const suvWords = ['rav4', 'cr-v', 'rogue', 'escape', 'explorer', 'tahoe', 'suburban', 'pilot', 'highlander', 'pathfinder', 'cx-', 'x3', 'x5', 'q5', 'q7', 'rx', 'nx', 'glc', 'gle'];
  const luxuryMakes = ['bmw', 'mercedes-benz', 'audi', 'lexus', 'acura', 'infiniti', 'genesis', 'porsche', 'cadillac', 'lincoln'];

  if (truckModels.some(x => m.includes(x))) return 'truck';
  if (suvWords.some(x => m.includes(x))) return 'suv';
  if (luxuryMakes.includes(mk)) return 'luxury';
  return 'sedan';
}

function basePriceBySegment(segment) {
  const prices = {
    sedan: 28000,
    suv: 38000,
    truck: 47000,
    luxury: 56000
  };
  return prices[segment] || 28000;
}

function brandMultiplier(make) {
  const mk = String(make || '').toLowerCase();

  if (['toyota', 'honda', 'lexus'].includes(mk)) return 1.08;
  if (['subaru', 'mazda'].includes(mk)) return 1.03;
  if (['hyundai', 'kia', 'nissan', 'volkswagen'].includes(mk)) return 0.97;
  if (['bmw', 'mercedes-benz', 'audi', 'porsche'].includes(mk)) return 1.18;
  if (['chrysler', 'dodge', 'mitsubishi', 'fiat'].includes(mk)) return 0.90;

  return 1.0;
}

function ageDepreciation(year) {
  const currentYear = new Date().getFullYear();
  const age = Math.max(0, currentYear - Number(year));

  if (age <= 1) return 0.86;
  if (age <= 2) return 0.76;
  if (age <= 3) return 0.68;
  if (age <= 5) return 0.56;
  if (age <= 7) return 0.45;
  if (age <= 10) return 0.32;
  return 0.22;
}

function mileageAdjustment(mileage, year) {
  const currentYear = new Date().getFullYear();
  const age = Math.max(1, currentYear - Number(year));
  const expectedMiles = age * 12000;
  const ratio = Number(mileage || 0) / expectedMiles;

  if (ratio <= 0.65) return 1.08;
  if (ratio <= 0.90) return 1.04;
  if (ratio <= 1.15) return 1.00;
  if (ratio <= 1.50) return 0.93;
  if (ratio <= 2.00) return 0.86;
  return 0.76;
}

function trimMultiplier(trim) {
  const t = String(trim || '').toLowerCase();

  if (!t || t === 'any trim') return { multiplier: 1.0, label: 'No trim selected' };

  if (['base', 's', 'lx', 'l', 'se'].some(x => t === x || t.includes(` ${x} `))) {
    return { multiplier: 0.97, label: 'Base/lower trim adjustment' };
  }

  if (['sport', 'xle', 'ex', 'sel', 'lt', 'premium', 'limited'].some(x => t.includes(x))) {
    return { multiplier: 1.05, label: 'Mid/high trim adjustment' };
  }

  if (['platinum', 'touring', 'reserve', 'denali', 'high country', 'king ranch', 'trd pro', 'type r', 'm sport', 'amg', 'rs'].some(x => t.includes(x))) {
    return { multiplier: 1.12, label: 'Premium/performance trim adjustment' };
  }

  return { multiplier: 1.03, label: 'Trim adjustment applied' };
}

function regionalMultiplier(zip) {
  const z = String(zip || '').trim();
  const firstTwo = z.slice(0, 2);

  const regionMap = {
    '90': 1.08, '91': 1.08, '92': 1.06, '93': 1.06, '94': 1.10, '95': 1.08,
    '10': 1.05, '11': 1.05, '07': 1.05, '08': 1.03, '02': 1.06, '06': 1.04,
    '75': 1.02, '76': 1.02, '77': 1.01, '78': 1.00,
    '46': 0.96, '47': 0.96, '48': 0.96, '49': 0.96, '50': 0.95, '51': 0.95, '52': 0.95,
    '30': 0.98, '31': 0.98, '32': 0.99, '33': 1.01, '34': 1.00,
    '80': 1.02, '81': 1.01, '97': 1.03, '98': 1.05
  };

  return regionMap[firstTwo] || 1.0;
}

function estimatePrice({ year, make, model, trim, mileage, price, zip }) {
  const segment = getSegment(make, model);
  const trimInfo = trimMultiplier(trim);

  const base = basePriceBySegment(segment);
  const brand = brandMultiplier(make);
  const age = ageDepreciation(year);
  const miles = mileageAdjustment(mileage, year);
  const regional = regionalMultiplier(zip);

  const fairPrice = money(base * brand * age * miles * trimInfo.multiplier * regional);
  const rangeLow = money(fairPrice * 0.90);
  const rangeHigh = money(fairPrice * 1.10);
  const suggestedOffer = money(Math.min(price, fairPrice) * 0.94);

  const askingPrice = Number(price);
  let rating = 'Fair Deal';
  if (askingPrice <= fairPrice * 0.95) rating = 'Great Deal';
  if (askingPrice > fairPrice * 1.08) rating = 'Overpriced';

  let confidence = 'Medium — estimated from model-based pricing, not live comps.';
  if (year >= 2020 && trim && trim !== 'Any Trim') confidence = 'Medium — newer vehicle and trim selected, but still a free estimate.';
  if (year < 2012 || !trim || trim === 'Any Trim') confidence = 'Low — older vehicle or no trim selected, so estimate is less precise.';

  const why = [
    `Classified as ${segment}, using a starting segment baseline of $${base.toLocaleString()}.`,
    `${make} brand factor applied: ${(brand * 100).toFixed(0)}% of baseline.`,
    `Age/depreciation factor applied for model year ${year}: ${(age * 100).toFixed(0)}%.`,
    `Mileage factor applied for ${Number(mileage).toLocaleString()} miles: ${(miles * 100).toFixed(0)}%.`,
    `${trimInfo.label}: ${(trimInfo.multiplier * 100).toFixed(0)}%.`,
    `Regional ZIP adjustment for ${zip}: ${(regional * 100).toFixed(0)}%.`
  ];

  return {
    mode: 'free-estimate',
    fairPrice,
    rangeLow,
    rangeHigh,
    suggestedOffer,
    askingPrice,
    rating,
    confidence,
    segment,
    why,
    trimUsed: trim || 'Any Trim'
  };
}

app.get('/api/years', (req, res) => {
  const currentYear = new Date().getFullYear() + 1;
  const years = [];
  for (let y = currentYear; y >= 1995; y--) years.push(y);
  res.json({ years });
});

app.get('/api/makes', async (req, res) => {
  try {
    const data = await cachedGet(
      'makes-car',
      'https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/car?format=json'
    );

    const makes = [...new Set(data.Results.map(x => x.MakeName))]
      .filter(Boolean)
      .sort();

    res.json({ makes });
  } catch {
    res.status(500).json({ error: 'Could not load makes' });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const { year, make } = req.query;
    const data = await cachedGet(
      `models-${year}-${make}`,
      `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}?format=json`
    );

    const models = [...new Set(data.Results.map(x => x.Model_Name))]
      .filter(Boolean)
      .sort();

    res.json({ models });
  } catch {
    res.status(500).json({ error: 'Could not load models' });
  }
});

app.get('/api/trims', (req, res) => {
  const { make, model } = req.query;
  const generic = ['Any Trim', 'Base', 'S', 'SE', 'SEL', 'Sport', 'Limited', 'Premium', 'Touring', 'Platinum'];

  const mk = String(make || '').toLowerCase();
  const md = String(model || '').toLowerCase();

  let trims = generic;

  if (mk === 'volkswagen' && md.includes('jetta')) trims = ['Any Trim', 'S', 'Sport', 'SE', 'SEL', 'GLI'];
  if (mk === 'toyota' && md.includes('camry')) trims = ['Any Trim', 'LE', 'SE', 'XLE', 'XSE', 'TRD'];
  if (mk === 'honda' && md.includes('civic')) trims = ['Any Trim', 'LX', 'Sport', 'EX', 'Touring', 'Type R'];
  if (mk === 'ford' && md.includes('f-150')) trims = ['Any Trim', 'XL', 'XLT', 'Lariat', 'King Ranch', 'Platinum', 'Raptor'];
  if (mk === 'chevrolet' && md.includes('silverado')) trims = ['Any Trim', 'WT', 'Custom', 'LT', 'RST', 'LTZ', 'High Country'];
  if (mk === 'ram' && md.includes('1500')) trims = ['Any Trim', 'Tradesman', 'Big Horn', 'Laramie', 'Rebel', 'Limited'];
  if (mk === 'tesla') trims = ['Any Trim', 'Standard Range', 'Long Range', 'Performance', 'Plaid'];

  res.json({ trims });
});

app.post('/api/free-estimate', (req, res) => {
  const result = estimatePrice(req.body);
  res.json(result);
});

app.post('/api/live-comps', async (req, res) => {
  try {
    const { year, make, model, trim, mileage, price, zip, radius, unlockCode } = req.body;

    if (unlockCode !== 'PAID-DEMO') {
      return res.status(402).json({ error: 'Live comps are paywalled. Use PAID-DEMO for testing.' });
    }

    if (!MARKETCHECK_API_KEY) {
      return res.status(500).json({ error: 'Missing MARKETCHECK_API_KEY in .env' });
    }

    const response = await axios.get('https://api.marketcheck.com/v2/search/car/active', {
      params: {
        api_key: MARKETCHECK_API_KEY,
        year,
        make,
        model,
        zip,
        radius: radius || 75,
        rows: 25
      }
    });

    const listings = response.data.listings || [];

    const unavailablePriceListings = listings
      .filter(car => !car.price)
      .map(car => ({
        ...car,
        displayYear: car.year || car.build?.year || year,
        displayMake: car.build?.make || make,
        displayModel: car.build?.model || model,
        displayTrim: car.build?.trim || '',
        price: null,
        miles: car.miles ? Number(car.miles) : null,
        dist: Number(car.dist || 0)
      }));

    const valid = listings
      .filter(car => car.price)
      .map(car => ({
        ...car,
        displayYear: car.year || car.build?.year || year,
        displayMake: car.build?.make || make,
        displayModel: car.build?.model || model,
        displayTrim: car.build?.trim || '',
        price: Number(car.price),
        miles: car.miles ? Number(car.miles) : null,
        dist: Number(car.dist || 0)
      }));

    if (!valid.length) {
      return res.json({
        error: 'No usable live comps with prices found.',
        unavailableCount: unavailablePriceListings.length
      });
    }

    const prices = valid.map(car => car.price);
    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;

    const weightedPrices = [];
    const weights = [];

    valid.forEach(car => {
      let weight = 1;

      if (car.miles && mileage) {
        const mileageDiff = Math.abs(car.miles - Number(mileage));
        weight += Math.max(0, 1 - mileageDiff / 100000);
      }

      if (car.dist) {
        weight += Math.max(0, 1 - car.dist / 100);
      }

      if (
        trim &&
        trim !== 'Any Trim' &&
        String(car.displayTrim).toLowerCase().includes(String(trim).toLowerCase())
      ) {
        weight += 1.5;
      }

      const priceDiffRatio = avgPrice > 0 ? Math.abs(car.price - avgPrice) / avgPrice : 0;

      if (priceDiffRatio > 0.30) {
        weight *= 0.5;
      } else if (priceDiffRatio > 0.20) {
        weight *= 0.7;
      } else if (priceDiffRatio > 0.10) {
        weight *= 0.85;
      }

      weightedPrices.push(car.price);
      weights.push(weight);
    });

    const fairPrice = money(weightedMedian(weightedPrices, weights));

    const askingPrice = Number(price);
    const cheaperCount = valid.filter(c => c.price < askingPrice).length;
    const percentile = money((cheaperCount / valid.length) * 100);

    let suggestedOffer;

    if (askingPrice < fairPrice) {
      suggestedOffer = money(askingPrice * 0.97);
    } else {
      suggestedOffer = money(fairPrice * (cheaperCount >= 3 ? 0.92 : 0.95));
    }

    let rating = 'Fair Deal';
    if (askingPrice <= fairPrice * 0.97) rating = 'Great Deal';
    if (askingPrice > fairPrice * 1.05) rating = 'Overpriced';

    let confidenceText;

    if (valid.length >= 8) {
      confidenceText = 'High — strong number of priced listings in your area.';
    } else if (valid.length >= 4) {
      confidenceText = 'Medium — limited priced listings in your area.';
    } else {
      confidenceText = 'Low — very few priced listings found nearby.';
    }

    const comps = valid
      .map(car => ({
        ...car,
        valueScore: getValueScore(car, trim, mileage),
        valueLabel: getValueLabel(car, trim)
      }))
      .sort((a, b) => b.valueScore - a.valueScore)
      .slice(0, 8);

    const why = [
      `MarketCheck returned ${listings.length} nearby listing(s).`,
      `Used ${valid.length} priced live comp(s) for pricing math.`,
      `${unavailablePriceListings.length} additional listing(s) had unavailable prices and were not used in the fair price calculation.`,
      `All priced comps were included, but listings far from the market average were weighted less heavily so one very cheap or very expensive car does not skew the result.`,
      `Weights favor closer mileage, closer distance, and matching trim for fair-price calculation.`,
      `Better-deal ranking also considers trim level, so a higher trim at similar price and mileage can rank above a lower trim.`,
      `${cheaperCount} priced comp(s) were cheaper than the asking price.`
    ];

    res.json({
      mode: 'live-comps',
      fairPrice,
      suggestedOffer,
      askingPrice,
      percentile,
      rating,
      cheaperCount,
      compCount: valid.length,
      totalReturnedCount: listings.length,
      unavailablePriceCount: unavailablePriceListings.length,
      confidence: confidenceText,
      why,
      negotiationScript:
        askingPrice < fairPrice
          ? `This vehicle is already listed below the estimated fair market value of $${fairPrice.toLocaleString()}. ` +
            `I would not offer above the asking price. A reasonable starting offer would be around $${suggestedOffer.toLocaleString()}, ` +
            `but if the car checks out mechanically, paying close to the $${askingPrice.toLocaleString()} asking price may already be a good deal.`
          : `Based on live nearby comps, fair market value looks close to $${fairPrice.toLocaleString()}. ` +
            `I’d start around $${suggestedOffer.toLocaleString()} and reference the priced comparable listings.`,
      comps,
      unavailablePriceComps: unavailablePriceListings.slice(0, 5)
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Live comps error. Check MarketCheck key or response.' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
