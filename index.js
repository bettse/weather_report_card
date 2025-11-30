const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

// CR80 PDF size requested: 640 x 1006
const WIDTH = 640;
const HEIGHT = 1006;

// Determine CURRENT_DATETIME: use optional env override or provided timestamp; compute target local date (if local hour >= 6 use next local day), using local midnight to avoid UTC rollover
const now = process.env.CURRENT_DATETIME_OVERRIDE ? new Date(process.env.CURRENT_DATETIME_OVERRIDE) : new Date('2025-11-30T03:27:07.830Z');
const offset = now.getHours() >= 6 ? 1 : 0;
// targetLocalMidnight is at local 00:00 of the chosen date
const targetLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0);
const CURRENT_DATETIME = targetLocalMidnight;
const TARGET_DATE_UTC = {
  y: CURRENT_DATETIME.getUTCFullYear(),
  m: CURRENT_DATETIME.getUTCMonth(),
  d: CURRENT_DATETIME.getUTCDate(),
};

// KPDX coordinates (Portland International Airport)
const LAT = 45.5886;
const LON = -122.5975;

function mapForecastToState(shortForecast, isDaytime) {
  const s = (shortForecast || '').toLowerCase();
  if (/thunder/i.test(s)) return (s.includes('rain') || s.includes('showers')) ? 'lightning-rainy' : 'lightning';
  if (s.includes('sunny')) return 'sunny';
  if (s.includes('clear')) return isDaytime ? 'sunny' : 'clear-night';
  if (s.includes('partly')) return 'partlycloudy';
  if (s.includes('cloud')) return 'cloudy';
  if (s.includes('fog') || s.includes('mist') || s.includes('haze')) return 'fog';
  if (s.includes('snow') && s.includes('rain')) return 'snowy-rainy';
  if (s.includes('snow') || s.includes('flurr')) return 'snowy';
  if (s.includes('sleet') || s.includes('wintry')) return 'snowy-rainy';
  if (s.includes('hail')) return 'hail';
  if (s.includes('pour') || s.includes('heavy')) return 'pouring';
  if (s.includes('rain') || s.includes('showers') || s.includes('drizzle')) return 'rainy';
  if (s.includes('wind')) return 'windy';
  return 'unknown';
}

async function fetchForecast() {
  const pointsUrl = `https://api.weather.gov/points/${LAT},${LON}`;
  const headers = { 'User-Agent': 'kpdx-forecast-app (github.com)', Accept: 'application/geo+json,application/json' };

  const pResp = await fetch(pointsUrl, { headers });
  if (!pResp.ok) throw new Error('Failed to get point metadata: ' + pResp.statusText);
  const pjson = await pResp.json();
  const forecastUrl = pjson.properties && pjson.properties.forecast;
  if (!forecastUrl) throw new Error('Forecast URL not found in point metadata');

  const fResp = await fetch(forecastUrl, { headers });
  if (!fResp.ok) throw new Error('Failed to get forecast: ' + fResp.statusText);
  const fjson = await fResp.json();
  return fjson.properties && fjson.properties.periods ? fjson.properties.periods : [];
}

function isSameUTCDate(isoString) {
  const d = new Date(isoString);
  return d.getUTCFullYear() === TARGET_DATE_UTC.y && d.getUTCMonth() === TARGET_DATE_UTC.m && d.getUTCDate() === TARGET_DATE_UTC.d;
}

async function buildPdf(periods) {
  // pick periods for the target date
  const todays = periods.filter(p => isSameUTCDate(p.startTime));
  if (!todays.length) throw new Error('No forecast periods found for target date');

  // prefer a daytime period for the summary, otherwise first
  let chosen = todays.find(p => p.isDaytime) || todays[0];
  const state = mapForecastToState(chosen.shortForecast, chosen.isDaytime);

  // assemble a single-period summary (daytime preferred)
  const summaryLines = `${chosen.name}: ${chosen.shortForecast}.`;
  const tempText = `${chosen.temperature}${chosen.temperatureUnit}`;

  const outPath = path.join(__dirname, 'kpdx_forecast_cr80.pdf');
  // create PDF in landscape: swap width/height
  const doc = new PDFDocument({ size: [HEIGHT, WIDTH], margin: 20 });
  const ws = fs.createWriteStream(outPath);
  doc.pipe(ws);

  // draw background SVG if available (now stored in svgs/)
  const svgPath = path.join(__dirname, 'svgs', `${state}_cr80.svg`);
  if (fs.existsSync(svgPath)) {
    try {
      const svg = fs.readFileSync(svgPath, 'utf8');
      // draw SVG to fill the page
      // draw SVG to fill the page (landscape)
      SVGtoPDF(doc, svg, 0, 0, { width: HEIGHT, height: WIDTH });
    } catch (e) {
      // continue without background
      console.error('Failed to render SVG background:', e.message);
    }
  }

  // overlay text box (larger for CR80)
  // header left
  doc.fillColor('#000').fontSize(36).text('KPDX Forecast', 30, 30);
  // date upper-right
  const dateStr = CURRENT_DATETIME.toISOString().slice(0,10);
  doc.fontSize(18).fillColor('#000').text(dateStr, 30, 30, { width: HEIGHT - 60, align: 'right' });
  // layout: prominent temp on right
  const bodyY = 90;
  doc.fontSize(64).fillColor('#111').text(tempText, 30, bodyY - 6, { width: HEIGHT - 60, align: 'right' });
  // weather description centered at bottom
  const bottomY = WIDTH - 80;
  doc.fontSize(22).fillColor('#000').text(summaryLines, 30, bottomY, { width: HEIGHT - 60, align: 'center' });

  doc.end();

  await new Promise((res, rej) => ws.on('finish', res).on('error', rej));
  console.log('PDF written to', outPath);
}

(async () => {
  try {
    const periods = await fetchForecast();
    await buildPdf(periods);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
