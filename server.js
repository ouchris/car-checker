require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const MARKETCHECK_API_KEY = process.env.MARKETCHECK_API_KEY;
const cache = new Map();

async function cachedGet(key, url) {
  if (cache.has(key)) return cache.get(key);

  const res = await axios.get(url);

  cache.set(key, res.data);

  return res.data;
}

function normalizeMarketCheckModel(make, model) {
  const mk = String(make || '').toLowerCase();

  let md = String(model || '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (mk === 'ford') {
    if (/f\s*-?\s*150/i.test(md)) return 'F-150';
    if (/f\s*-?\s*250/i.test(md)) return 'F-250';
    if (/f\s*-?\s*350/i.test(md)) return 'F-350';
  }

  return md;
}

app.get('/api/years', (req, res) => {
  const currentYear = new Date().getFullYear() + 1;

  const years = [];

  for (let y = currentYear; y >= 1995; y--) {
    years.push(y);
  }

  res.json({ years });
});

app.get('/api/makes', async (req, res) => {
  try {
    const data = await cachedGet(
      'makes',
      'https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/car?format=json'
    );

    const makes = [...new Set(data.Results.map(x => x.MakeName))]
      .filter(Boolean)
      .sort();

    res.json({ makes });

  } catch {
    res.status(500).json({ error: 'Failed loading makes' });
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
    res.status(500).json({ error: 'Failed loading models' });
  }
});

app.post('/api/live-comps', async (req, res) => {
  try {
    const {
      year,
      make,
      model,
      zip,
      radius
    } = req.body;

    if (!MARKETCHECK_API_KEY) {
      return res.status(500).json({
        error: 'Missing MARKETCHECK_API_KEY'
      });
    }

    const marketModel = normalizeMarketCheckModel(make, model);

    const response = await axios.get(
      'https://api.marketcheck.com/v2/search/car/active',
      {
        params: {
          api_key: MARKETCHECK_API_KEY,
          year,
          make,
          model: marketModel,
          zip,
          radius: radius || 75,
          rows: 50
        }
      }
    );

    const listings = response.data.listings || [];

    const comps = listings
      .filter(car => car.price)
      .map(car => ({
        id: car.id,
        price: Number(car.price),
        miles: car.miles ? Number(car.miles) : null,
        dist: Number(car.dist || 0),

        year: car.year || '',
        make: car.build?.make || make,
        model: car.build?.model || model,
        trim: car.build?.trim || '',

        dealerName: car.dealer?.name || 'Unknown Dealer',
        city: car.dealer?.city || '',
        state: car.dealer?.state || '',

        image: car.media?.photo_links?.[0] || '',
        link: car.vdp_url || ''
      }));

    if (!comps.length) {
      return res.json({
        error: 'No comparable listings found.'
      });
    }

    res.json({
      total: comps.length,
      comps
    });

  } catch (err) {
    console.error(err.response?.data || err.message);

    res.status(500).json({
      error: 'Failed loading comparable listings.'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
