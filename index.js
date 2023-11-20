import puppeteer, {KnownDevices} from 'puppeteer'
import {writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'

const BASE_TRACE_PATH = 'traces/%-trace.tmp.json'

// run multiple iterations in case of A/B testing
const ITERATIONS = 5

const NORMAL_USER_AGENT =
  'Mozilla/5.0 (Linux Android 7.0 Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4590.2 Mobile Safari/537.36'
const LIGHT_HOUSE_USER_AGENT =
  'Mozilla/5.0 (Linux Android 7.0 Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4590.2 Mobile Safari/537.36 Chrome-Lighthouse'

// Lighthouse uses this device
const DEVICE_CODE = 'Moto G4'
const DEVICE = KnownDevices[DEVICE_CODE]

const WEBSITE_URLS = [
  'https://www.mykitsch.com/', // MANUALLY REVIEWED BASELINE: NOT MALICIOUS OR CLOAKING (pre-rendered by ems)
  'https://skims.com/', // MANUALLY REVIEWED BASELINE: NOT MALICIOUS OR CLOAKING (server-buffered by Hydrogen)
  'https://wearfigs.com/', // MANUALLY REVIEWED BASELINE: NOT MALICIOUS OR CLOAKING
]

async function initBrowser(userAgent) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--unlimited-storage',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  })

  const page = await browser.newPage()
  await page.emulate(DEVICE)
  await page.setUserAgent(userAgent)

  const randomStr = randomBytes(16).toString('hex')
  const tracePath = BASE_TRACE_PATH.replace('%', randomStr)

  await page.tracing.start({path: tracePath, categories: ['devtools.timeline']})

  return {page, browser, tracePath}
}

function calculateCloakingProbability(metricsRegular, metricsBot) {
  const thresholds = {
    loadTimeMs: {weight: 1, maxDiff: 3000, tolerance: 0.3},
    domSize: {weight: 2, maxDiff: 500, tolerance: 0.3},
    totalSize: {weight: 1, maxDiff: 15, tolerance: 0.3},
    imagesLoadedCount: {weight: 3, maxDiff: 30, tolerance: 0.2},
    externalScriptCount: {weight: 4, maxDiff: 50, tolerance: 0.2},
  }

  let score = 0
  let totalWeight = 0

  for (let metric in thresholds) {
    const diff = Math.abs(metricsRegular[metric] - metricsBot[metric])
    const normalizedDiff = Math.min(diff / thresholds[metric].maxDiff, 1)
    const effectiveDiff =
      normalizedDiff - thresholds[metric].tolerance > 0
        ? normalizedDiff - thresholds[metric].tolerance
        : 0
    score += effectiveDiff * thresholds[metric].weight
    totalWeight += thresholds[metric].weight
  }

  const svgHackPenalty = 20
  if (metricsRegular.svgHack || metricsBot.svgHack) {
    score += svgHackPenalty
  }

  return (
    (score / (totalWeight + (metricsRegular.svgHack || metricsBot.svgHack ? svgHackPenalty : 0))) *
    100
  ).toFixed(2)
}

async function getSerializedDOMSize(page) {
  const serializedDOM = await page.evaluate(() => new XMLSerializer().serializeToString(document))
  const sizeInBytes = new TextEncoder().encode(serializedDOM).length
  const sizeInKilobytes = sizeInBytes / 1024

  return sizeInKilobytes
}

async function captureMetrics(url, userAgent) {
  const {page, browser, tracePath} = await initBrowser(userAgent)

  const resources = []
  page.on('response', response => {
    if (!response.ok() && response.status() >= 300 && response.status() <= 399) {
      return
    }

    if (response.request().method() === 'OPTIONS') {
      return
    }

    response
      .buffer()
      .then(buffer => {
        resources.push({
          url: response.url(),
          size: buffer.length,
          type: response.request().resourceType(),
        })
      })
      .catch(() => {})
  })

  await page.evaluateOnNewDocument(() => {
    window.lcpElement = null
    window.pageLoadTime = null

    window.addEventListener('load', () => {
      const pageEnd = performance.mark('pageEnd')
      const loadTime = pageEnd.startTime
      window.pageLoadTime = loadTime
    })

    new PerformanceObserver(entryList => {
      const entries = entryList.getEntries()
      for (const entry of entries) {
        if (entry.entryType === 'largest-contentful-paint') {
          window.lcpElement = entry.element
        }
      }
    }).observe({type: 'largest-contentful-paint', buffered: true})
  })

  await page.goto(url, {
    waitUntil: ['networkidle2', 'load'],
    timeout: 3000000,
  })

  const externalScripts = resources.filter(
    resource => resource.type === 'script' && !resource.url.startsWith(url)
  )
  const images = resources.filter(
    resource => resource.type === 'image' && !resource.url.startsWith(url)
  )
  const totalSize = resources.reduce((acc, resource) => acc + resource.size, 0) / 1024 / 1024 // MB

  const dimensions = await page.evaluate(() => {
    return {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }
  })

  const isLargeTransparentSVG = element => {
    return (
      element.isSVG &&
      ((element.width > dimensions.width && element.height > dimensions.height) ||
        (element.width > dimensions.width && element.height < 5))
    )
  }

  const lcpElement = await page.evaluate(() => {
    const lcp = window.lcpElement
    return lcp
      ? {
          width: lcp.getAttribute('width')?.replace('px', '') ?? lcp.clientWidth,
          height: lcp.getAttribute('height')?.replace('px', '') ?? lcp.clientHeight,
          tagName: lcp.tagName,
          // checking if it is an svg or an image w/ embedded svg
          isSVG:
            lcp.tagName === 'SVG' ||
            (lcp.tagName === 'IMG' && lcp.getAttribute('src')?.includes('data:image/svg+xml;')),
        }
      : null
  })

  const loadTime = await page.evaluate(() => {
    return window.pageLoadTime
  })

  const domSize = await getSerializedDOMSize(page)
  const performanceTimings = await page.evaluate(() => JSON.parse(JSON.stringify(window.performance.timing)))
  const pageContent = await page.content()

  await page.tracing.stop()
  await page.close()
  await browser.close()

  return {
    loadTimeMs: loadTime,
    domSize,
    totalSize,
    imagesLoadedCount: images.length,
    externalScriptCount: externalScripts.length,
    svgHack: lcpElement && isLargeTransparentSVG(lcpElement),
    lcpElement,
    tracePath,
    performanceTimings,
    pageContent,
  }
}

async function main() {
  const results = []

  for (const url of WEBSITE_URLS) {
    const tests = []
    let totalProbability = 0

    for (let i = 0; i < ITERATIONS; i++) {
      const standardMetrics = await captureMetrics(url, NORMAL_USER_AGENT)
      const lighthouseMetrics = await captureMetrics(url, LIGHT_HOUSE_USER_AGENT)

      const probabilityOfCloaking = calculateCloakingProbability(standardMetrics, lighthouseMetrics)
      totalProbability += parseFloat(probabilityOfCloaking)

      tests.push({
        standardMetrics: {
          ...standardMetrics,
          userAgent: NORMAL_USER_AGENT,
          device: DEVICE_CODE,
        },
        lighthouseMetrics: {
          ...lighthouseMetrics,
          userAgent: LIGHT_HOUSE_USER_AGENT,
          device: DEVICE_CODE,
        },
        probabilityOfCloaking,
      })
    }

    const averageProbability = (totalProbability / ITERATIONS).toFixed(2)
    console.log(`Probability of cloaking on "${url}" is ${averageProbability}%.`)

    results.push({
      url,
      probability: averageProbability,
      iterations: ITERATIONS,
      tests,
    })
  }

  const fileName = `full-results-${Date.now()}.json`
  await writeFile(fileName, JSON.stringify(results), 'utf-8')
  console.log(`Results written to ${fileName}`)
}

main()
