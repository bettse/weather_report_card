const fs = require('fs');
const util = require("util");
const path = require('path');
const fetch = require('node-fetch');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const ipp = require("ipp");

// CR80 PDF size requested: 640 x 1006
const WIDTH = 640;
const HEIGHT = 1006;

// Layout and typography constants
const MARGIN = 20;
const HEADER_FONT_SIZE = 48;
const TEMP_FONT_SIZE = 80;
const DESC_FONT_SIZE = 80;
const BODY_Y = 90;
const H_TEXT_PADDING = 60; // horizontal padding to subtract from HEIGHT for text width
const BOTTOM_MARGIN = 20;
const TEXT_HEIGHT_MULT = 1.1;

// Determine CURRENT_DATETIME: use optional env override or provided timestamp; compute target local date (if local hour >= 6 use next local day), using local midnight to avoid UTC rollover
const now = process.env.CURRENT_DATETIME_OVERRIDE ? new Date(process.env.CURRENT_DATETIME_OVERRIDE) : new Date();
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


const uri = "ipp://localhost:631/printers/Zebra_Technologies_ZTC_ZC350";
const printer = ipp.Printer(uri);

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
  const hourlyUrl = pjson.properties && pjson.properties.forecastHourly;
  if (!forecastUrl) throw new Error('Forecast URL not found in point metadata');

  const fResp = await fetch(forecastUrl, { headers });
  if (!fResp.ok) throw new Error('Failed to get forecast: ' + fResp.statusText);
  const fjson = await fResp.json();

  let hourlyPeriods = [];
  if (hourlyUrl) {
    try {
      const hResp = await fetch(hourlyUrl, { headers });
      if (hResp.ok) {
        const hjson = await hResp.json();
        hourlyPeriods = hjson.properties && hjson.properties.periods ? hjson.properties.periods : [];
      }
    } catch (e) {
      // ignore hourly fetch errors
    }
  }

  return { periods: (fjson.properties && fjson.properties.periods) ? fjson.properties.periods : [], hourly: hourlyPeriods };
}

function isSameUTCDate(isoString) {
  const d = new Date(isoString);
  return d.getUTCFullYear() === TARGET_DATE_UTC.y && d.getUTCMonth() === TARGET_DATE_UTC.m && d.getUTCDate() === TARGET_DATE_UTC.d;
}

async function buildPdf(data) {
  // pick periods for the target date
  const todays = data.periods.filter(p => isSameUTCDate(p.startTime));
  if (!todays.length) throw new Error('No forecast periods found for target date');

  // prefer a daytime period for the summary, otherwise first
  let chosen = todays.find(p => p.isDaytime) || todays[0];
  const state = mapForecastToState(chosen.shortForecast, chosen.isDaytime);

  // assemble a single-period summary (daytime preferred)
  const summaryLines = `${chosen.shortForecast}.`;
  const tempText = `${chosen.temperature}${chosen.temperatureUnit}`;

  const y = CURRENT_DATETIME.getFullYear();
  const m = String(CURRENT_DATETIME.getMonth() + 1).padStart(2, '0');
  const d = String(CURRENT_DATETIME.getDate()).padStart(2, '0');
  const filename = `${y}${m}${d}.pdf`;
  const outPath = path.join(__dirname, filename);
  // create PDF in landscape: swap width/height
  const doc = new PDFDocument({ size: [HEIGHT, WIDTH], margin: MARGIN });
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
  doc.fillColor('#000').fontSize(HEADER_FONT_SIZE).text('KPDX Forecast', 30, 30);
  // date upper-right (human-friendly, same size as header)
  const dateStr = CURRENT_DATETIME.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  doc.fontSize(HEADER_FONT_SIZE).fillColor('#000').text(dateStr, 30, 30, { width: HEIGHT - H_TEXT_PADDING, align: 'right' });
  // layout: compute day's high/low from hourly data and place low left-middle, high right-middle
  const bodyY = BODY_Y;
  const hourly = data.hourly || [];
  const todaysHourly = hourly.filter(h => isSameUTCDate(h.startTime));
  let lowText = '';
  let highText = '';
  if (todaysHourly && todaysHourly.length) {
    const temps = todaysHourly.map(h => h.temperature).filter(t => typeof t === 'number');
    if (temps.length) {
      const min = Math.min(...temps);
      const max = Math.max(...temps);
      const unit = (todaysHourly.find(h => h.temperatureUnit) || {}).temperatureUnit || (chosen.temperatureUnit || '');
      lowText = `${min}${unit}`;
      highText = `${max}${unit}`;
    }
  } else {
    // fallback to chosen temp
    lowText = tempText;
    highText = tempText;
  }
  // place low on left-middle and high on right-middle
  const centerY = doc.page.height / 2;
  const tempY = Math.max(0, centerY - Math.round(TEMP_FONT_SIZE / 2));
  doc.fontSize(TEMP_FONT_SIZE).fillColor('#111').text(lowText, 30, tempY, { width: doc.page.width / 2 - 60, align: 'left' });
  doc.fontSize(TEMP_FONT_SIZE).fillColor('#111').text(highText, doc.page.width / 2, tempY, { width: doc.page.width / 2 - 30, align: 'right' });
  // weather description centered at bottom
  doc.fontSize(DESC_FONT_SIZE).fillColor('#000');
  const textWidth = HEIGHT - H_TEXT_PADDING;
  const textHeight = doc.heightOfString(summaryLines, { width: textWidth, align: 'center' }) * TEXT_HEIGHT_MULT;
  // desired bottom start
  let bottomY = doc.page.height - BOTTOM_MARGIN - textHeight;
  doc.text(summaryLines, 30, bottomY, { width: textWidth, align: 'center' });

  doc.end();

  await new Promise((res, rej) => ws.on('finish', res).on('error', rej));
  console.log('PDF written to', outPath);
  return outPath;
}

async function printPdf(filePath) {
  const print = util.promisify(printer.execute).bind(printer);

  try {
    const pdf = fs.readFileSync(filePath);

    const request = {
      "operation-attributes-tag": {
        "requesting-user-name": "kpdx-forecast-app",
        "document-format": "application/pdf",
      },
      "job-attributes-tag": {
        "media": "CR80",
        "fitplot": true,
      },
      data: pdf,
    };

    const result = await print("Print-Job", request);
    return result;
  } catch (error) {
    console.error("Error printing PDF:", error);
  }
}

(async () => {
  try {
    const data = await fetchForecast();
    const path = await buildPdf(data);
    await printPdf(path);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
